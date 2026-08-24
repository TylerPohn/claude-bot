import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 — see the note in test/mentions.test.ts
import { evaluateHandoff, handoffDenialText } from '../src/main/orchestration/HandoffManager.ts'
import type { AppSettings, Bot } from '@shared/types'

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    title: null,
    description: '',
    avatarType: 'emoji',
    avatarValue: '🤖',
    accent: 'violet',
    defaultWorkingDirectory: null,
    model: 'default',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    pinned: false,
    hidden: false,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const BUILDER = bot('bot_builder', 'Builder')
const REVIEWER = bot('bot_reviewer', 'Reviewer')
const OUTSIDER = bot('bot_debugger', 'Debugger')
const MEMBERS = [BUILDER, REVIEWER]

const SETTINGS: Pick<
  AppSettings,
  'handoffsEnabled' | 'maxHandoffDepth' | 'maxAutomatedTurnsPerHumanMessage'
> = {
  handoffsEnabled: true,
  maxHandoffDepth: 3,
  maxAutomatedTurnsPerHumanMessage: 8
}

function evaluate(overrides: Partial<Parameters<typeof evaluateHandoff>[0]> = {}) {
  return evaluateHandoff({
    request: {
      fromBotId: 'bot_builder',
      toBotName: 'Reviewer',
      message: 'Please review the auth changes.',
      conversationId: 'conv_1'
    },
    members: MEMBERS,
    currentDepth: 0,
    automatedTurnsSoFar: 0,
    settings: SETTINGS,
    ...overrides
  })
}

test('a valid handoff is allowed and deepens the chain by one', () => {
  assert.deepEqual(evaluate(), { allowed: true, toBotId: 'bot_reviewer', nextDepth: 1 })
})

test('bot names resolve case-insensitively and tolerate a leading @', () => {
  for (const name of ['reviewer', 'REVIEWER', '  Reviewer  ', '@Reviewer']) {
    const decision = evaluate({
      request: {
        fromBotId: 'bot_builder',
        toBotName: name,
        message: 'x',
        conversationId: 'conv_1'
      }
    })
    assert.equal(decision.allowed, true, name)
    assert.equal(decision.toBotId, 'bot_reviewer')
  }
})

test('rejects when handoffs are disabled globally', () => {
  const decision = evaluate({ settings: { ...SETTINGS, handoffsEnabled: false } })
  assert.deepEqual(decision, { allowed: false, reason: 'disabled' })
})

test('rejects a self-handoff', () => {
  const decision = evaluate({
    request: { fromBotId: 'bot_builder', toBotName: 'Builder', message: 'x', conversationId: 'conv_1' }
  })
  assert.deepEqual(decision, { allowed: false, reason: 'self' })
})

test('rejects an unknown name', () => {
  const decision = evaluate({
    request: { fromBotId: 'bot_builder', toBotName: 'Nobody', message: 'x', conversationId: 'conv_1' }
  })
  assert.deepEqual(decision, { allowed: false, reason: 'unknown-bot' })
})

test('rejects an empty name', () => {
  const decision = evaluate({
    request: { fromBotId: 'bot_builder', toBotName: '  @  ', message: 'x', conversationId: 'conv_1' }
  })
  assert.deepEqual(decision, { allowed: false, reason: 'unknown-bot' })
})

test('a real bot outside the conversation is not-a-member, not unknown', () => {
  const request = {
    fromBotId: 'bot_builder',
    toBotName: 'Debugger',
    message: 'x',
    conversationId: 'conv_1'
  }
  assert.deepEqual(evaluate({ request, allBots: [...MEMBERS, OUTSIDER] }), {
    allowed: false,
    reason: 'not-a-member'
  })
  // Without the full roster we cannot tell the two apart and say so honestly.
  assert.deepEqual(evaluate({ request }), { allowed: false, reason: 'unknown-bot' })
})

test('rejects when the next hop would exceed maxHandoffDepth', () => {
  assert.equal(evaluate({ currentDepth: 2 }).allowed, true)
  assert.deepEqual(evaluate({ currentDepth: 3 }), { allowed: false, reason: 'depth' })
  assert.deepEqual(evaluate({ currentDepth: 9 }), { allowed: false, reason: 'depth' })
})

test('maxHandoffDepth 0 forbids every handoff', () => {
  const decision = evaluate({ settings: { ...SETTINGS, maxHandoffDepth: 0 } })
  assert.deepEqual(decision, { allowed: false, reason: 'depth' })
})

test('rejects once the automated turn budget for this human message is spent', () => {
  assert.equal(evaluate({ automatedTurnsSoFar: 7 }).allowed, true)
  assert.deepEqual(evaluate({ automatedTurnsSoFar: 8 }), { allowed: false, reason: 'turn-budget' })
  assert.deepEqual(evaluate({ automatedTurnsSoFar: 40 }), { allowed: false, reason: 'turn-budget' })
})

test('a bad name is reported as a bad name even when the budget is also spent', () => {
  const decision = evaluate({
    automatedTurnsSoFar: 99,
    currentDepth: 99,
    request: { fromBotId: 'bot_builder', toBotName: 'Ghost', message: 'x', conversationId: 'conv_1' }
  })
  assert.equal(decision.reason, 'unknown-bot')
})

test('the disabled switch outranks every other rejection', () => {
  const decision = evaluate({
    settings: { ...SETTINGS, handoffsEnabled: false },
    currentDepth: 99,
    automatedTurnsSoFar: 99,
    request: { fromBotId: 'bot_builder', toBotName: 'Ghost', message: 'x', conversationId: 'conv_1' }
  })
  assert.equal(decision.reason, 'disabled')
})

test('every rejection reason has user-facing copy that never mentions billing', () => {
  const reachable = ['Reviewer', 'Researcher']
  for (const reason of ['disabled', 'depth', 'turn-budget', 'unknown-bot', 'not-a-member', 'self'] as const) {
    const text = handoffDenialText(reason, 'Ghost', reachable)
    assert.ok(text.length > 0)
    assert.ok(!/api key|billing|credit card/i.test(text), reason)
  }
  assert.ok(handoffDenialText('unknown-bot', 'Ghost', reachable).includes('“Ghost”'))
  // An unrecognised reason must still say something, not fall off the end.
  assert.ok(handoffDenialText(undefined, 'Ghost').length > 0)
})

/**
 * The reason this distinction exists at all: telling a model that a Bot it can
 * see does not exist sends it looking for another name instead of telling the
 * human to add that Bot to the group.
 */
test('a real Bot outside the group is named as a non-member, with who IS reachable', () => {
  const text = handoffDenialText('not-a-member', 'Debugger', ['Reviewer', 'Researcher'])
  assert.ok(text.includes('is not a member of this conversation'))
  assert.ok(!text.includes('There is no Bot named'))
  assert.ok(text.includes('Reviewer, Researcher'))

  const alone = handoffDenialText('not-a-member', 'Debugger', [])
  assert.ok(alone.includes('no one else here'))
})
