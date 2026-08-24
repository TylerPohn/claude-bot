/**
 * Local, deterministic router (PRD §11.4).
 *
 * The whole point of this module is that deciding WHICH bot answers must never
 * cost a Claude turn. The user is on a subscription, and burning a model call
 * just to pick a recipient would be an obvious waste of their allowance. Every
 * rule below is a pure data decision, and the chosen `reason` is returned so the
 * UI can explain itself ("replied because you @mentioned it", "replied because
 * it is this group's default responder").
 */
import type { Bot, ConversationType, MessageMention } from '@shared/types'

export interface RouteInput {
  conversationType: ConversationType
  /** Conversation members in membership order — this order is the tie-breaker. */
  members: Bot[]
  mentions: MessageMention[]
  routing: { mode: 'auto' } | { mode: 'everyone' } | { mode: 'bot'; botId: string }
  defaultResponderBotId: string | null
  /** Bots with a job already running or queued anywhere. */
  busyBotIds: string[]
}

export type RouteReason =
  | 'direct'
  | 'explicit-mentions'
  | 'everyone'
  | 'routing-override'
  | 'default-responder'
  | 'idle-fallback'
  | 'first-member'

export interface RouteResult {
  botIds: string[]
  reason: RouteReason
  /** True when this send fans out to the whole roster (drives the >4 confirm). */
  everyone: boolean
  /**
   * Bots the message named that are NOT in this conversation, deduped and in the
   * order they were mentioned.
   *
   * Rule 3 below filters them out, which used to be the end of it: "@Debugger fix
   * the crash" in a group Debugger is not in fell through to auto and a different
   * Bot answered, with nothing anywhere saying that the Bot the user addressed
   * never heard them. Routing still behaves exactly the same — the PRD scopes
   * explicit routing to valid member mentions (§11.2) — but the caller now has
   * what it needs to say so. Empty in the overwhelmingly common case.
   */
  unreachableBotIds: string[]
}

function memberIds(members: Bot[]): string[] {
  return members.map((m) => m.id)
}

/** Named bots that are not members. Order follows the message, not the roster. */
function unreachable(mentions: MessageMention[], idSet: Set<string>): string[] {
  const out: string[] = []
  for (const mention of mentions) {
    const botId = mention.botId
    if (botId === null || idSet.has(botId) || out.includes(botId)) continue
    out.push(botId)
  }
  return out
}

export function routeMessage(input: RouteInput): RouteResult {
  const { members, mentions, routing } = input
  const ids = memberIds(members)
  const idSet = new Set(ids)
  const unreachableBotIds = unreachable(mentions, idSet)

  // 1. Direct chat: there is exactly one member and it always answers. Mentions
  //    and the routing selector are irrelevant here (PRD §11.1).
  if (input.conversationType === 'direct') {
    return { botIds: ids.slice(0, 1), reason: 'direct', everyone: false, unreachableBotIds }
  }

  // 2. Explicit @everyone / @all beats everything else the user could have set,
  //    because it is the most specific thing they typed in this message.
  if (mentions.some((m) => m.everyone)) {
    return { botIds: ids, reason: 'everyone', everyone: true, unreachableBotIds }
  }

  // 3. Explicit bot mentions: exactly those bots, deduped, filtered to current
  //    membership (a mentioned bot may have been removed from the group since),
  //    emitted in membership order so fan-out order is stable and predictable.
  const mentioned = new Set(
    mentions.map((m) => m.botId).filter((id): id is string => id !== null && idSet.has(id))
  )
  if (mentioned.size > 0) {
    return {
      botIds: ids.filter((id) => mentioned.has(id)),
      reason: 'explicit-mentions',
      everyone: false,
      unreachableBotIds
    }
  }

  // 4. The composer's routing selector. It only applies when the message text did
  //    not already name a recipient.
  if (routing.mode === 'everyone') {
    return { botIds: ids, reason: 'routing-override', everyone: true, unreachableBotIds }
  }
  if (routing.mode === 'bot' && idSet.has(routing.botId)) {
    return {
      botIds: [routing.botId],
      reason: 'routing-override',
      everyone: false,
      unreachableBotIds
    }
  }
  // A `bot` override naming a non-member falls through to auto rather than
  // silently addressing nobody — the bot was probably just removed from the group.

  if (ids.length === 0) {
    return { botIds: [], reason: 'first-member', everyone: false, unreachableBotIds }
  }

  // 5. Auto: the group's configured default responder, when it is still a member.
  if (input.defaultResponderBotId !== null && idSet.has(input.defaultResponderBotId)) {
    return {
      botIds: [input.defaultResponderBotId],
      reason: 'default-responder',
      everyone: false,
      unreachableBotIds
    }
  }

  // 6. Auto: if every member but one is busy, the one idle bot is almost
  //    certainly who the user is talking to (PRD §11.4 rule 2).
  const busy = new Set(input.busyBotIds)
  const idle = ids.filter((id) => !busy.has(id))
  if (idle.length === 1 && ids.length > 1) {
    return { botIds: [idle[0]!], reason: 'idle-fallback', everyone: false, unreachableBotIds }
  }

  // 7. Auto: first member in membership order. Deterministic, never a model call.
  return { botIds: [ids[0]!], reason: 'first-member', everyone: false, unreachableBotIds }
}
