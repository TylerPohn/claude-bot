import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 — see the note in test/mentions.test.ts
import { planDelivery } from '../src/main/orchestration/delivery.ts'
import type { Message, MessageStatus } from '@shared/types'

/* ------------------------------------------------------------------ *
 * A stand-in for the messages table
 *
 * It implements only the two behaviours the read watermark depends on, and it
 * implements them the way SQLite does:
 *   - rows are ordered by the composite `(created_at, seq)`;
 *   - `since(after)` hides rows that are still being written (queued / running /
 *     streaming), and returns everything strictly after the anchor row — whatever
 *     that anchor's own status is.
 * Both are the real statements in src/main/db/repositories/messages.ts.
 * ------------------------------------------------------------------ */

const IN_FLIGHT: MessageStatus[] = ['queued', 'running', 'streaming']

interface Row {
  message: Message
  seq: number
}

class Transcript {
  readonly rows: Row[] = []
  #seq = 0

  add(partial: Partial<Message> & { id: string }): Message {
    this.#seq += 1
    const message: Message = {
      conversationId: 'conv_1',
      authorType: 'bot',
      authorBotId: null,
      authorName: null,
      authorAvatarType: null,
      authorAvatarValue: null,
      authorAccent: null,
      bodyMarkdown: partial.id,
      thinkingMarkdown: '',
      replyToMessageId: null,
      status: 'complete',
      systemKind: null,
      handoffFromBotId: null,
      jobId: null,
      errorText: null,
      mentions: [],
      attachments: [],
      activities: [],
      reactions: [],
      usage: null,
      // Every row of one fan-out really can land in the same millisecond, which is
      // exactly why `seq` exists and why a timestamp alone cannot order them.
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...partial
    }
    this.rows.push({ message, seq: this.#seq })
    return message
  }

  finish(id: string, body: string): void {
    const row = this.rows.find((candidate) => candidate.message.id === id)
    assert.ok(row, `no such row ${id}`)
    row.message = { ...row.message, status: 'complete', bodyMarkdown: body }
  }

  /** `messagesRepo.since()`. */
  since(afterId: string | null, excludeIds: string[] = []): Message[] {
    const anchor = afterId === null ? null : this.rows.find((r) => r.message.id === afterId)
    const excluded = new Set(excludeIds)
    return this.rows
      .filter((row) => (anchor ? row.seq > anchor.seq : true))
      .filter((row) => !IN_FLIGHT.includes(row.message.status))
      .filter((row) => !excluded.has(row.message.id))
      .map((row) => row.message)
  }

  /** The scheduler's `#idsAfterOldestInFlight`, in the same terms. */
  idsAfterOldestInFlight(selfMessageId: string): Set<string> {
    const barriers = this.rows.filter(
      (row) => IN_FLIGHT.includes(row.message.status) && row.message.id !== selfMessageId
    )
    if (barriers.length === 0) return new Set()
    const oldest = barriers.reduce((a, b) => (a.seq <= b.seq ? a : b))
    return new Set(this.since(oldest.message.id).map((message) => message.id))
  }
}

/**
 * One turn's worth of the scheduler's bookkeeping: what the bot is shown, and
 * where its watermark ends up. Mirrors JobScheduler.#run.
 */
interface BotState {
  lastSeen: string | null
  seenAhead: Set<string>
}

function takeTurn(
  transcript: Transcript,
  state: BotState,
  input: { ownPlaceholderId: string; triggeringMessageId: string | null }
): string[] {
  const unseen = transcript.since(state.lastSeen, [input.ownPlaceholderId])
  const replayed = unseen.filter(
    (message) => message.id !== input.triggeringMessageId && !state.seenAhead.has(message.id)
  )

  const delivered = new Set(replayed.map((message) => message.id))
  if (input.triggeringMessageId) delivered.add(input.triggeringMessageId)
  for (const id of state.seenAhead) delivered.add(id)

  const plan = planDelivery({
    previousLastSeenId: state.lastSeen,
    unseen,
    delivered,
    afterBarrier: transcript.idsAfterOldestInFlight(input.ownPlaceholderId)
  })
  state.lastSeen = plan.lastSeenMessageId
  state.seenAhead = new Set(plan.seenAheadIds)

  return replayed.map((message) => message.id)
}

/* ------------------------------------------------------------------ *
 * The regression this module exists for
 * ------------------------------------------------------------------ */

test('a peer Bot that finishes late is still delivered, not skipped forever', () => {
  const transcript = new Transcript()
  const alpha: BotState = { lastSeen: null, seenAhead: new Set() }

  // The user fans out to a two-Bot group; both placeholders are created up front.
  const m1 = transcript.add({ id: 'm1', authorType: 'user', authorName: 'Tyler' })
  const pAlpha = transcript.add({ id: 'p_alpha', status: 'queued', authorBotId: 'bot_alpha' })
  const pBravo = transcript.add({ id: 'p_bravo', status: 'queued', authorBotId: 'bot_bravo' })

  const turn1 = takeTurn(transcript, alpha, {
    ownPlaceholderId: pAlpha.id,
    triggeringMessageId: m1.id
  })
  assert.deepEqual(turn1, [], 'nothing to replay: the trigger is delivered as the task')
  transcript.finish(pAlpha.id, 'Alpha: all green')

  // Bravo is STILL streaming when the user comes back with a follow-up. This is
  // the step that used to lose Bravo: the follow-up sorts after Bravo's row, so
  // the old "newest row we read" watermark jumped straight over it.
  const m2 = transcript.add({ id: 'm2', authorType: 'user', authorName: 'Tyler' })
  const pAlpha2 = transcript.add({ id: 'p_alpha_2', status: 'queued', authorBotId: 'bot_alpha' })
  takeTurn(transcript, alpha, { ownPlaceholderId: pAlpha2.id, triggeringMessageId: m2.id })
  assert.equal(alpha.lastSeen, pAlpha.id, 'the watermark must stop before the in-flight row')
  assert.deepEqual([...alpha.seenAhead], [m2.id], 'what was read past the barrier is remembered')

  transcript.finish(pBravo.id, 'Bravo: the deploy is blocked')
  transcript.finish(pAlpha2.id, 'Alpha: noted')

  // Alpha is invoked again. Bravo's reply is older than Alpha's watermark under
  // the broken behaviour, so this is where it either arrives or is gone for good.
  const m3 = transcript.add({ id: 'm3', authorType: 'user', authorName: 'Tyler' })
  const pAlpha3 = transcript.add({ id: 'p_alpha_3', status: 'queued', authorBotId: 'bot_alpha' })
  const turn3 = takeTurn(transcript, alpha, {
    ownPlaceholderId: pAlpha3.id,
    triggeringMessageId: m3.id
  })

  assert.ok(turn3.includes(pBravo.id), "Bravo's reply must reach Alpha")
  assert.ok(!turn3.includes(m2.id), 'a message already delivered must not be replayed')
  // Nothing is in flight any more except Alpha's own placeholder, which is never
  // its own barrier, so the watermark catches up with the whole backlog.
  assert.equal(alpha.lastSeen, m3.id, 'with nothing in flight the watermark catches up')
  assert.deepEqual([...alpha.seenAhead], [], 'and the ahead-set is pruned')
})

test('a four-Bot fan-out delivers every reply to the Bot that ran last', () => {
  const transcript = new Transcript()
  const names = ['alpha', 'bravo', 'charlie', 'delta']
  const states = new Map(names.map((name) => [name, { lastSeen: null, seenAhead: new Set() } as BotState]))

  const m1 = transcript.add({ id: 'm1', authorType: 'user', authorName: 'Tyler' })
  const placeholders = new Map(
    names.map((name) => [name, transcript.add({ id: `p_${name}`, status: 'queued', authorBotId: `bot_${name}` })])
  )

  // Charlie is a short turn and finishes while Alpha and Bravo are still going;
  // that is what frees a slot for Delta (maxConcurrentBots = 3 by default).
  transcript.finish('p_charlie', 'Charlie: done')
  takeTurn(transcript, states.get('charlie')!, {
    ownPlaceholderId: 'p_charlie',
    triggeringMessageId: m1.id
  })
  takeTurn(transcript, states.get('delta')!, {
    ownPlaceholderId: placeholders.get('delta')!.id,
    triggeringMessageId: m1.id
  })

  transcript.finish('p_alpha', 'Alpha: done')
  transcript.finish('p_bravo', 'Bravo: done')
  transcript.finish('p_delta', 'Delta: done')

  const m2 = transcript.add({ id: 'm2', authorType: 'user', authorName: 'Tyler' })
  const pDelta2 = transcript.add({ id: 'p_delta_2', status: 'queued', authorBotId: 'bot_delta' })
  const replayed = takeTurn(transcript, states.get('delta')!, {
    ownPlaceholderId: pDelta2.id,
    triggeringMessageId: m2.id
  })

  assert.ok(replayed.includes('p_alpha'), 'Alpha must reach Delta')
  assert.ok(replayed.includes('p_bravo'), 'Bravo must reach Delta')
  assert.ok(!replayed.includes('p_charlie'), 'Charlie was already delivered on turn 1')
})

/* ------------------------------------------------------------------ *
 * planDelivery itself
 * ------------------------------------------------------------------ */

function m(id: string): Message {
  return new Transcript().add({ id })
}

test('with nothing in flight the watermark moves to the newest delivered message', () => {
  const unseen = [m('a'), m('b'), m('c')]
  const plan = planDelivery({
    previousLastSeenId: null,
    unseen,
    delivered: new Set(['a', 'b', 'c']),
    afterBarrier: new Set()
  })
  assert.deepEqual(plan, { lastSeenMessageId: 'c', seenAheadIds: [] })
})

test('the watermark stops at the barrier and remembers what was read past it', () => {
  const unseen = [m('a'), m('b'), m('c')]
  const plan = planDelivery({
    previousLastSeenId: 'older',
    unseen,
    delivered: new Set(['a', 'b', 'c']),
    // 'b' and 'c' sort after a message that is still being written.
    afterBarrier: new Set(['b', 'c'])
  })
  assert.deepEqual(plan, { lastSeenMessageId: 'a', seenAheadIds: ['b', 'c'] })
})

test('an undelivered message blocks the watermark exactly like a barrier does', () => {
  const unseen = [m('a'), m('b'), m('c')]
  const plan = planDelivery({
    previousLastSeenId: null,
    unseen,
    delivered: new Set(['a', 'c']),
    afterBarrier: new Set()
  })
  assert.deepEqual(plan, { lastSeenMessageId: 'a', seenAheadIds: ['c'] })
})

test('an empty backlog leaves the watermark exactly where it was', () => {
  const plan = planDelivery({
    previousLastSeenId: 'msg_7',
    unseen: [],
    delivered: new Set(),
    afterBarrier: new Set()
  })
  assert.deepEqual(plan, { lastSeenMessageId: 'msg_7', seenAheadIds: [] })
})
