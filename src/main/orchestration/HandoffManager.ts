/**
 * Loop protection for bot-to-bot handoffs (PRD §13.3).
 *
 * Handoffs are the one place where the app can spend the user's Claude
 * subscription without a human pressing anything: Bot A calls the local MCP tool,
 * Bot B wakes up, Bot B calls it back, and two agents can ping-pong until the
 * allowance is gone. Every rejection below exists to stop that, and each returns a
 * distinct `reason` so the visible system notice can say exactly what happened.
 *
 * Pure module: it decides, it does not enqueue.
 */
import type { AppSettings, Bot } from '@shared/types'

export interface HandoffRequest {
  fromBotId: string
  toBotName: string
  message: string
  conversationId: string
}

export type HandoffRejection =
  | 'disabled'
  | 'depth'
  | 'turn-budget'
  | 'unknown-bot'
  | 'not-a-member'
  | 'self'

export interface HandoffDecision {
  allowed: boolean
  reason?: HandoffRejection
  toBotId?: string
  /** Handoff depth to stamp on the job we are about to create. */
  nextDepth?: number
}

export interface HandoffEvaluationInput {
  request: HandoffRequest
  /** Members of the conversation the handoff happens in, in membership order. */
  members: Bot[]
  /** Depth of the job that issued this request (a human-triggered job is 0). */
  currentDepth: number
  /** Automated turns already spawned by the human message at the root of this chain. */
  automatedTurnsSoFar: number
  settings: Pick<
    AppSettings,
    'handoffsEnabled' | 'maxHandoffDepth' | 'maxAutomatedTurnsPerHumanMessage'
  >
  /**
   * Optional full roster. When supplied we can tell "there is no such Bot" apart
   * from "that Bot exists but is not in this conversation", which is a much more
   * useful message for the model to read back. Optional so callers that only have
   * the member list still work.
   */
  allBots?: Bot[]
}

/** Models like to write "@Reviewer" or " reviewer " — normalize before lookup. */
function normalizeName(name: string): string {
  return name.trim().replace(/^@+/, '').trim().toLowerCase()
}

function findByName(bots: Bot[], normalized: string): Bot | null {
  for (const bot of bots) {
    if (bot.name.trim().toLowerCase() === normalized) return bot
  }
  return null
}

export function evaluateHandoff(input: HandoffEvaluationInput): HandoffDecision {
  const { settings, request } = input

  // 1. Global kill switch first: when the user turned handoffs off, nothing else
  //    about the request matters.
  if (!settings.handoffsEnabled) {
    return { allowed: false, reason: 'disabled' }
  }

  // 2. Resolve the target before the budget checks so a typo reads as a typo
  //    rather than as "you ran out of turns".
  const normalized = normalizeName(request.toBotName)
  if (normalized.length === 0) {
    return { allowed: false, reason: 'unknown-bot' }
  }

  const target = findByName(input.members, normalized)
  if (target === null) {
    const known = input.allBots ? findByName(input.allBots, normalized) : null
    return { allowed: false, reason: known !== null ? 'not-a-member' : 'unknown-bot' }
  }

  // 3. A bot handing off to itself is the tightest possible loop.
  if (target.id === request.fromBotId) {
    return { allowed: false, reason: 'self' }
  }

  // 4. Chain depth. `currentDepth` is the depth of the requesting job, so the job
  //    we would create sits one level deeper.
  const nextDepth = input.currentDepth + 1
  if (nextDepth > settings.maxHandoffDepth) {
    return { allowed: false, reason: 'depth' }
  }

  // 5. Total automated turns caused by one human message. Depth alone does not
  //    bound this: a fan-out at depth 1 can still spawn dozens of jobs.
  if (input.automatedTurnsSoFar >= settings.maxAutomatedTurnsPerHumanMessage) {
    return { allowed: false, reason: 'turn-budget' }
  }

  return { allowed: true, toBotId: target.id, nextDepth }
}

/**
 * The one copy for a refused handoff. It is read by the calling model as the tool
 * result AND posted as the visible `loop_guard` system notice for the depth and
 * turn-budget cases (PRD 13.3/13.4), so it has to work for both audiences and
 * never mention API keys or billing.
 *
 * `reachableMemberNames` are the OTHER members of the conversation: telling the
 * model who it can actually reach is the difference between a useful correction
 * and a model guessing another name.
 */
export function handoffDenialText(
  reason: HandoffRejection | string | undefined,
  toBotName: string,
  reachableMemberNames: string[] = []
): string {
  switch (reason) {
    case 'disabled':
      return 'Bot-to-Bot handoffs are turned off in this app’s settings.'
    case 'depth':
      return 'Handoff limit reached for this conversation. Finish your answer and let the human take the next step.'
    case 'turn-budget':
      return 'This conversation has used its automated turn budget. Finish your answer and let the human take the next step.'
    case 'unknown-bot':
      return `There is no Bot named “${toBotName}”. Use list_bots to see who is in this conversation.`
    case 'not-a-member':
      // Saying "there is no Bot named X" about a Bot that plainly exists sends the
      // model looking for a different name instead of asking the human to add it.
      return reachableMemberNames.length > 0
        ? `“${toBotName}” exists but is not a member of this conversation. You can hand off to: ${reachableMemberNames.join(', ')}.`
        : `“${toBotName}” exists but is not a member of this conversation, and there is no one else here to hand off to.`
    case 'self':
      return 'A Bot cannot hand work to itself.'
    default:
      return 'That handoff was not allowed.'
  }
}
