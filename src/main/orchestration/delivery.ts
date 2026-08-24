/**
 * How far a Bot has read its conversation (PRD §12.2).
 *
 * `bot_conversation_sessions.last_seen_message_id` is a single cursor compared as
 * the composite `(created_at, seq)`, so it can only express "everything up to
 * here has been delivered". That is not enough on its own, and getting it wrong
 * loses a teammate's reply permanently:
 *
 *   `messagesRepo.since()` deliberately hides messages that are still being
 *   written (queued / running / streaming) — half a sentence is worse than no
 *   sentence for another Bot. The scheduler used to then advance the watermark to
 *   the newest row that survived that filter. In a group, Bots finish out of
 *   order: while A and B are still streaming, C can finish and D can start, read
 *   a NEWER message than A's and B's placeholders, and park its watermark past
 *   them. When A and B finally complete, their rows sort BEFORE the watermark, so
 *   `since()` can never return them again. D silently never learns what half its
 *   team said, and there is no code path that revisits a crossed message.
 *
 * The fix is two-part, and both parts live here so they can be tested without a
 * database:
 *
 * 1. The durable cursor is a LOW-water mark: it may never advance past a message
 *    that was still in flight when the turn's context was built, because that
 *    message is going to become readable later.
 * 2. Everything delivered *ahead* of that mark is remembered separately for the
 *    life of the process, so the honest cursor does not cost the user a second
 *    copy of messages the Bot already read.
 *
 * Losing (2) — on quit, or on a Bot the process has never run — costs at most one
 * re-read of context the Bot has already seen. Losing (1) costs the message.
 *
 * Pure module: data in, plan out.
 */
import type { Message } from '@shared/types'

export interface DeliveryPlan {
  /** New value for `last_seen_message_id`; everything at or before it is delivered. */
  lastSeenMessageId: string | null
  /**
   * Ids delivered ahead of {@link lastSeenMessageId}, oldest first. Pass them back
   * as `delivered` on the next turn to keep them out of the bridge. Ids the
   * watermark has caught up with are dropped, so this set stays small.
   */
  seenAheadIds: string[]
}

export interface DeliveryInput {
  /** The Bot's watermark before this turn. */
  previousLastSeenId: string | null
  /**
   * Complete messages after `previousLastSeenId`, oldest first — exactly what
   * `messagesRepo.since()` returns, including any this Bot was already given on an
   * earlier turn.
   */
  unseen: Message[]
  /** Ids this Bot has been handed, on this turn or an earlier one. */
  delivered: ReadonlySet<string>
  /**
   * Ids that sort strictly after the oldest message that was still being written
   * when this turn's context was built. Those messages are the barrier: the
   * watermark must stop before them, because the in-flight message between them
   * will only become readable once it finishes.
   */
  afterBarrier: ReadonlySet<string>
}

export function planDelivery(input: DeliveryInput): DeliveryPlan {
  let lastSeenMessageId = input.previousLastSeenId
  const seenAheadIds: string[] = []
  // Sticky: `unseen` is ordered, so once we are past the barrier (or past a
  // message this Bot was not given) every later message is past it too.
  let stopped = false

  for (const message of input.unseen) {
    if (input.afterBarrier.has(message.id)) stopped = true
    if (!input.delivered.has(message.id)) {
      // Not handed over, so it must stay unseen — and the watermark must not step
      // over it on the way to something newer.
      stopped = true
      continue
    }
    if (stopped) seenAheadIds.push(message.id)
    else lastSeenMessageId = message.id
  }

  return { lastSeenMessageId, seenAheadIds }
}
