/**
 * The write path behind `messages:*` IPC and the local MCP control server.
 *
 * Everything that turns a human action into queued Bot work funnels through here
 * so that persistence, routing and enqueueing stay in one place:
 *
 *   send      user text  -> message row -> MentionRouter -> scheduler jobs
 *   retry     existing message -> the same instruction, re-enqueued (PRD 22)
 *   handoff   Bot's MCP tool call -> visible notice -> scheduler job (PRD 13)
 *
 * Routing never spends a model call (PRD 11.4): `MentionRouter` is pure and local.
 */
import { basename, extname } from 'node:path'

import type { AttachmentInput, SendMessageInput } from '@shared/schemas'
import type { Bot, BotJob, Conversation, Message, MessageMention, SystemMessageKind } from '@shared/types'
import type { SendMessageResult } from '@shared/types/api'

import { emit } from '@main/events'
import { botsRepo } from '@main/db/repositories/bots'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { jobsRepo } from '@main/db/repositories/jobs'
import { messagesRepo } from '@main/db/repositories/messages'
import { settingsRepo } from '@main/db/repositories/settings'
import { AppError } from '@main/lib/errors'
import { newId } from '@main/lib/id'
import { log } from '@main/lib/logger'
import { safeStat } from '@main/orchestration/attachments'
import { evaluateHandoff, handoffDenialText } from '@main/orchestration/HandoffManager'
import { getScheduler } from '@main/orchestration/JobScheduler'
import { routeMessage } from '@main/orchestration/MentionRouter'
import { parseMentions } from '@main/orchestration/mentions'

/** Groups larger than this ask before fanning out to everyone (PRD 11.3). */
const EVERYONE_CONFIRM_THRESHOLD = 4
/** Handoff notices quote the requesting Bot; cap so one card cannot flood the view. */
const HANDOFF_QUOTE_LIMIT = 2000

/**
 * How many `send_message_to_group` posts one turn may write (PRD 13.3, in
 * spirit).
 *
 * `send_message_to_bot` is bounded because each success enqueues a job that
 * counts against `maxAutomatedTurnsPerHumanMessage`. A group post wakes nobody,
 * so it counted against nothing at all: a stuck model could call the tool in a
 * loop and write an unbounded number of rows into the transcript at streaming
 * speed, each one a database insert plus a `message:created` to the renderer.
 * This is the only path by which a single turn creates more than one transcript
 * message, so it needs its own ceiling. Generous enough that no sane turn is
 * affected — a Bot with more than this many separate things to broadcast should
 * be writing its answer, not broadcasting.
 */
const MAX_GROUP_POSTS_PER_TURN = 8

/**
 * Group posts already written by the running turn, keyed by job id.
 *
 * Keyed by JOB rather than by attempt on purpose: a §37 session-recovery retry
 * re-runs the same job, and its budget should carry over rather than reset —
 * otherwise a turn that loops until it fails simply loops again after recovery.
 * Bounded by insertion order (same shape as the MCP grant registry) because
 * nothing here observes a job finishing; entries are tiny and only the newest
 * few can ever be consulted, since a counter is only read while its job runs.
 */
const groupPostsByJob = new Map<string, number>()
const GROUP_POST_COUNTER_MAX_ENTRIES = 64

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.tiff': 'image/tiff'
}

/**
 * `sendMessage` persists the user's message BEFORE the @everyone confirmation so
 * their typing is never lost while a dialog is open. The follow-up
 * `confirmEveryone` call therefore has to adopt that row instead of writing a
 * second copy of the same message — this map is that handoff.
 */
interface PendingEveryone {
  messageId: string
  body: string
}
const pendingEveryone = new Map<string, PendingEveryone>()

interface EnqueueContext {
  conversationId: string
  triggeringMessageId: string | null
  originMessageId: string | null
  handoffDepth: number
  handoff?: { fromBotId: string; fromBotName: string; note: string } | null
}

interface ResolvedAttachment {
  path: string
  name: string
  kind: 'file' | 'folder' | 'image'
  sizeBytes: number | null
  mimeType: string | null
  /** True when the path no longer exists — the UI dims the chip and the prompt says so. */
  missing: boolean
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function requireConversation(id: string): Conversation {
  const conversation = conversationsRepo.get(id)
  if (!conversation) throw new AppError('not_found', 'That conversation no longer exists.')
  return conversation
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emitConversation(id: string): void {
  const summary = conversationsRepo.getSummary(id)
  if (summary) emit('conversation:updated', { conversation: summary })
}

function touchConversation(id: string): void {
  conversationsRepo.touch(id)
  emitConversation(id)
}

function systemMessage(
  conversationId: string,
  systemKind: SystemMessageKind,
  body: string,
  handoffFromBotId: string | null = null,
  /** For a handoff, the RECIPIENT. The renderer reads the pair
   *  (handoffFromBotId -> authorBot) to draw "A handed off to B", so both ends
   *  must be recorded structurally rather than baked into the body text. */
  authorBot: Bot | null = null
): Message {
  const message = messagesRepo.create({
    conversationId,
    authorType: 'system',
    authorBot,
    bodyMarkdown: body,
    status: 'complete',
    systemKind,
    handoffFromBotId
  })
  emit('message:created', { message })
  return message
}

/**
 * Attachments are stored by path, never copied (PRD 17.1). We stat each one at
 * send time so the transcript records what was actually there. The stored flag is
 * that historical record and is never rewritten; the scheduler re-stats the paths
 * itself at turn time (`orchestration/attachments.restatAttachments`), because a
 * turn can run long after the send.
 */
function resolveAttachments(inputs: AttachmentInput[]): ResolvedAttachment[] {
  return inputs.map((raw) => {
    const stat = safeStat(raw.path)
    const extension = extname(raw.path).toLowerCase()
    const mimeType = raw.mimeType ?? IMAGE_EXTENSIONS[extension] ?? null

    let kind: 'file' | 'folder' | 'image' = raw.kind ?? 'file'
    if (stat?.isDirectory()) kind = 'folder'
    else if (stat?.isFile() && mimeType !== null && mimeType.startsWith('image/')) kind = 'image'

    return {
      path: raw.path,
      name: raw.name || basename(raw.path),
      kind,
      // Trust the filesystem over whatever the renderer reported.
      sizeBytes: stat?.isFile() ? stat.size : (raw.sizeBytes ?? null),
      mimeType,
      missing: stat === undefined
    }
  })
}

/**
 * Mention candidates in priority order: this conversation's members first, then
 * every other Bot in the app.
 *
 * Parsing the WHOLE roster is what lets `MentionRouter` report that "@Debugger"
 * named a real Bot that is simply not in this group. Parsing members only made
 * that name invisible, so the message fell through to auto-routing and a
 * different Bot answered with nothing saying why (see `unreachableBotIds`).
 *
 * Members must come first: `buildCandidates` resolves a duplicate name to the
 * first candidate it sees, so a member always wins over a same-named outsider.
 */
function mentionRoster(members: Bot[]): Bot[] {
  const memberIds = new Set(members.map((member) => member.id))
  // Hidden bots included: a hidden Bot is put away, not gone, and typing its name
  // in a group it is not in deserves the same answer as any other outsider.
  return [...members, ...botsRepo.list(true).filter((bot) => !memberIds.has(bot.id))]
}

/**
 * The composer sends structured mentions (PRD 11.5) so a Bot rename never
 * rewrites history. Those committed marks are authoritative for what they cover —
 * their `display` is the rename-proof record routing runs on — but NOT for what
 * the body contains, so the text is always re-parsed against the full roster and
 * the two are merged.
 *
 * The old "non-empty list means the composer already found everything" shortcut
 * was wrong in one specific, common way: the composer builds its mention options
 * from MEMBERS only, so a hand-typed "@Debugger" in a group Debugger is not in
 * never becomes a mark. If the same message also named one member, the shortcut
 * fired and main never learned "@Debugger" had been written — `unreachableBotIds`
 * came back empty and the "that Bot is not in this conversation" notice stayed
 * silent, so the safety net fired only for messages that named no member at all.
 */
function resolveMentions(
  body: string,
  provided: SendMessageInput['mentions'],
  members: Bot[]
): MessageMention[] {
  const committed: MessageMention[] = (provided ?? []).map((mention) => ({
    botId: mention.botId ?? null,
    display: mention.display,
    everyone: mention.everyone ?? false,
    startIndex: mention.startIndex,
    endIndex: mention.endIndex
  }))
  // The roster read is the expensive part, and it needs an '@' to be worth doing.
  if (!body.includes('@')) return committed

  const parsed = parseMentions(body, mentionRoster(members))
  if (committed.length === 0) return parsed

  // A committed mark wins any span it overlaps; the parsed marks only fill the
  // gaps between them. Sorted by position so the stored shape matches what the
  // hand-typed path already produces (and what `segmentMentions` renders from).
  const merged = [...committed]
  for (const candidate of parsed) {
    const overlaps = committed.some(
      (mark) => candidate.startIndex < mark.endIndex && mark.startIndex < candidate.endIndex
    )
    if (!overlaps) merged.push(candidate)
  }
  return merged.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Say, in the transcript, that the message named a Bot that is not here.
 *
 * The router deliberately keeps routing the message somewhere (PRD 11.2 scopes
 * explicit routing to member mentions), so without this the ONLY signal was that
 * "@Debugger" rendered as plain text instead of a chip — invisible in a scrolling
 * transcript and invisible in the sidebar preview, while a different Bot spent a
 * turn on it. A system row rather than a toast, so it survives scrollback and
 * matches the "No Bots are left in this conversation" precedent above. The
 * wording mirrors `handoffDenialText('not-a-member')`, which already draws this
 * exact distinction for the model.
 *
 * Kind `generic`, NOT `bot_removed`: the renderer stamps every `bot_removed` card
 * with the fixed heading "A Bot in this conversation was removed", and nobody was
 * removed here. `generic` renders the body on its own, which is what this needs.
 */
function reportUnreachableMentions(
  conversation: Conversation,
  unreachableBotIds: string[],
  members: Bot[]
): void {
  if (unreachableBotIds.length === 0) return
  const names = unreachableBotIds.map((id) => botsRepo.get(id)?.name).filter((n) => n !== undefined)
  // A mention can name a Bot that has since been deleted outright; there is
  // nothing useful to say about a name we can no longer resolve.
  if (names.length === 0) return

  const one = names.length === 1
  const quoted = names.map((name) => `“${name}”`)
  const subject = one
    ? `${quoted[0]} is not in this conversation, so it did not see this message.`
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)} are not in this conversation, so they did not see this message.`
  // Both callers reject an empty conversation before they get here, so `members`
  // always has at least one name to offer.
  const advice =
    conversation.type === 'direct'
      ? `This is a 1:1 chat with ${members[0]?.name ?? 'one Bot'} — start a group to put more than one Bot on a thread.`
      : `Add ${one ? 'it' : 'them'} in the conversation details, or @mention someone here: ${members.map((m) => m.name).join(', ')}.`

  systemMessage(conversation.id, 'generic', `${subject} ${advice}`)
}

function busyBotIdsFor(members: Bot[]): string[] {
  return members.filter((bot) => jobsRepo.runningCountForBot(bot.id) > 0).map((bot) => bot.id)
}

/** Enqueue one job per Bot. One Bot failing to start must not block the others. */
function enqueueJobs(botIds: string[], context: EnqueueContext): BotJob[] {
  const scheduler = getScheduler()
  const jobs: BotJob[] = []
  for (const botId of botIds) {
    try {
      jobs.push(
        scheduler.enqueue({
          botId,
          conversationId: context.conversationId,
          triggeringMessageId: context.triggeringMessageId,
          originMessageId: context.originMessageId,
          handoffDepth: context.handoffDepth,
          handoff: context.handoff ?? null
        })
      )
    } catch (err) {
      log.error('conversation', `could not enqueue bot ${botId}`, err)
      emit('app:notice', {
        id: newId('notice'),
        level: 'error',
        title: 'Could not start a Bot',
        body: errorText(err),
        conversationId: context.conversationId
      })
    }
  }
  return jobs
}

/**
 * Hand `confirmEveryone` the row `performSend` already persisted for this draft,
 * so the confirmation adopts it instead of writing a second copy.
 *
 * There is deliberately NO age limit. There used to be one (10 minutes), and it
 * both consumed the map entry AND returned null, which stranded the persisted
 * row: `performSend` then created an identical second user message, the Bots all
 * answered the second one, and the first sat unanswered in the transcript — and,
 * being a complete non-empty user message, was replayed to every Bot as backlog
 * by `GroupContextBridge.shouldReplay`. Leaving a confirmation dialog open
 * through a meeting is ordinary; when the user finally clicks Run they are
 * confirming THAT row, however long it has been on screen.
 *
 * Nothing else needed the timer either: the map is in-memory so a restart clears
 * it, `cancelPendingEveryone` drops it on decline, `forgetPendingEveryone` drops
 * it if the row is deleted by another route, the body check below rejects a
 * different draft, and `performSend` re-reads the row so a vanished one still
 * falls back to creating a fresh message. Note the body branch returns null
 * without consuming the entry, for the same reason: an entry that is not adopted
 * must stay adoptable rather than leaving its row orphaned.
 */
function takePendingEveryone(conversationId: string, body: string): string | null {
  const pending = pendingEveryone.get(conversationId)
  if (!pending) return null
  if (pending.body !== body) return null
  pendingEveryone.delete(conversationId)
  return pending.messageId
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

interface SendOptions {
  /** Skip the @everyone confirmation gate (the user already answered it). */
  force: boolean
  /** Adopt an already-persisted user message instead of creating one. */
  existingMessageId?: string | null
}

function performSend(input: SendMessageInput, options: SendOptions): SendMessageResult {
  const conversation = requireConversation(input.conversationId)
  const members = conversationsRepo.members(conversation.id)
  const body = input.body ?? ''
  const routing = input.routing ?? { mode: 'auto' as const }

  const adopted = options.existingMessageId ? messagesRepo.get(options.existingMessageId) : null
  const mentions = adopted ? adopted.mentions : resolveMentions(body, input.mentions, members)

  let message = adopted
  if (!message) {
    message = messagesRepo.create({
      conversationId: conversation.id,
      authorType: 'user',
      bodyMarkdown: body,
      status: 'complete',
      replyToMessageId: input.replyToMessageId ?? null,
      mentions,
      attachments: resolveAttachments(input.attachments ?? [])
    })
    emit('message:created', { message })
  }

  if (members.length === 0) {
    // Every Bot was deleted or removed. The transcript survives (PRD 21), so keep
    // the user's message and explain why nothing is going to answer it.
    systemMessage(
      conversation.id,
      'bot_removed',
      'No Bots are left in this conversation. Add a Bot to continue.'
    )
    touchConversation(conversation.id)
    return { message, jobs: [] }
  }

  const route = routeMessage({
    conversationType: conversation.type,
    members,
    mentions,
    routing,
    defaultResponderBotId: conversation.defaultResponderBotId,
    busyBotIds: busyBotIdsFor(members)
  })

  const needsConfirm =
    route.everyone &&
    !options.force &&
    !conversation.skipEveryoneConfirm &&
    members.length > EVERYONE_CONFIRM_THRESHOLD

  if (needsConfirm) {
    pendingEveryone.set(conversation.id, { messageId: message.id, body })
    touchConversation(conversation.id)
    return {
      message,
      jobs: [],
      needsEveryoneConfirm: {
        conversationId: conversation.id,
        botCount: route.botIds.length,
        // The row is already in the transcript, so the dialog's Cancel needs a way
        // to take it back out again — see `cancelPendingEveryone`.
        pendingMessageId: message.id
      }
    }
  }

  // After the @everyone gate, so declining and then confirming does not post the
  // notice twice (`confirmEveryone` re-enters here with the same adopted row).
  // Before the jobs, so the answering Bot sees the correction in its backlog.
  reportUnreachableMentions(conversation, route.unreachableBotIds, members)

  const jobs = enqueueJobs(route.botIds, {
    conversationId: conversation.id,
    triggeringMessageId: message.id,
    originMessageId: message.id,
    handoffDepth: 0
  })

  log.info('conversation', `send routed to ${route.botIds.length} bot(s)`, {
    conversationId: conversation.id,
    reason: route.reason
  })

  touchConversation(conversation.id)
  return { message, jobs }
}

export function sendMessage(input: SendMessageInput): SendMessageResult {
  return performSend(input, { force: false })
}

/**
 * The user declined the @everyone fan-out (Cancel, Esc or a click on the scrim).
 *
 * `performSend` persists the user's message BEFORE the gate so their typing is
 * never lost while the dialog is open, which means declining has to take that row
 * back out. Leaving it is not cosmetic: it is a complete, non-empty user message,
 * so `GroupContextBridge.shouldReplay` accepts it and the instruction the user
 * just declined to fan out reaches every Bot in the group anyway — as unanswered
 * context — the next time any of them runs.
 *
 * Returns the id of the removed row, or null when there was nothing pending
 * (already confirmed, already cancelled, or the app restarted meanwhile).
 */
export function cancelPendingEveryone(conversationId: string): { messageId: string | null } {
  const pending = pendingEveryone.get(conversationId)
  if (!pending) return { messageId: null }
  pendingEveryone.delete(conversationId)

  // No TTL check here: an old pending row is still the row the user is declining.
  if (!messagesRepo.get(pending.messageId)) return { messageId: null }
  messagesRepo.remove(pending.messageId)
  emit('message:deleted', { messageId: pending.messageId, conversationId })
  emitConversation(conversationId)
  return { messageId: pending.messageId }
}

/**
 * Keeps the pending map honest when the gated row is deleted by another route
 * (the message row menu, or a renderer that cancels with `messages.remove`).
 * Without it, `confirmEveryone` would later try to adopt a row that is gone.
 */
export function forgetPendingEveryone(conversationId: string, messageId: string): void {
  if (pendingEveryone.get(conversationId)?.messageId === messageId) {
    pendingEveryone.delete(conversationId)
  }
}

export function confirmEveryone(input: SendMessageInput & { remember: boolean }): SendMessageResult {
  const conversation = requireConversation(input.conversationId)
  if (input.remember && !conversation.skipEveryoneConfirm) {
    conversationsRepo.update(conversation.id, { skipEveryoneConfirm: true })
    emitConversation(conversation.id)
  }
  const existingMessageId = takePendingEveryone(conversation.id, input.body ?? '')
  return performSend(input, { force: true, existingMessageId })
}

/* ------------------------------------------------------------------ *
 * Retry
 * ------------------------------------------------------------------ */

/**
 * Re-runs the same human instruction (PRD 22). This is deliberately NOT branch
 * regeneration: Claude Code's `--resume` keeps one linear session, so we replay
 * the instruction and let the Bot answer again below the previous attempt.
 * Nothing is cancelled and nothing is deleted.
 */
export function retry(messageId: string): SendMessageResult {
  const target = messagesRepo.get(messageId)
  if (!target) throw new AppError('not_found', 'That message no longer exists.')
  if (target.authorType === 'system') {
    throw new AppError('invalid_input', 'System notices cannot be retried.')
  }

  const conversation = requireConversation(target.conversationId)
  const members = conversationsRepo.members(conversation.id)
  if (members.length === 0) {
    throw new AppError('conflict', 'This conversation has no Bots left to run.')
  }

  if (target.authorType === 'bot') {
    // Retrying one Bot's answer re-runs exactly that Bot, not the whole fan-out.
    const botId = target.authorBotId
    if (!botId) throw new AppError('invalid_input', 'That message cannot be retried.')
    if (!members.some((member) => member.id === botId)) {
      throw new AppError(
        'conflict',
        `${target.authorName ?? 'That Bot'} is no longer in this conversation.`
      )
    }

    const job = target.jobId ? jobsRepo.get(target.jobId) : null
    const trigger = job?.triggeringMessageId ? messagesRepo.get(job.triggeringMessageId) : null
    const jobs = enqueueJobs([botId], {
      conversationId: conversation.id,
      triggeringMessageId: trigger?.id ?? null,
      originMessageId: job?.originMessageId ?? trigger?.id ?? null,
      // Preserve the depth so a retried handoff still counts against the budget.
      handoffDepth: job?.handoffDepth ?? 0
    })
    touchConversation(conversation.id)
    return { message: trigger ?? target, jobs }
  }

  const route = routeMessage({
    conversationType: conversation.type,
    members,
    mentions: target.mentions,
    // The composer's routing selector is transient; the persisted mentions are
    // the durable record of who this message was for.
    routing: { mode: 'auto' },
    defaultResponderBotId: conversation.defaultResponderBotId,
    busyBotIds: busyBotIdsFor(members)
  })

  // Retry is the other door into the same drop: the persisted mentions may name a
  // Bot that has left the group since the message was written.
  reportUnreachableMentions(conversation, route.unreachableBotIds, members)

  const jobs = enqueueJobs(route.botIds, {
    conversationId: conversation.id,
    triggeringMessageId: target.id,
    originMessageId: target.id,
    handoffDepth: 0
  })
  touchConversation(conversation.id)
  return { message: target, jobs }
}

/* ------------------------------------------------------------------ *
 * Bot-to-Bot handoffs (local MCP control server deps)
 * ------------------------------------------------------------------ */

function runningJobFor(botId: string, conversationId: string): BotJob | null {
  const active = jobsRepo.activeForConversation(conversationId)
  return active.find((job) => job.botId === botId && job.status === 'running') ?? null
}

function truncateQuote(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > HANDOFF_QUOTE_LIMIT
    ? `${trimmed.slice(0, HANDOFF_QUOTE_LIMIT)}…`
    : trimmed
}

/**
 * `mcp__claude_code_bots__send_message_to_bot`. Returns a text result for the
 * calling model rather than throwing — a tool error would just make Claude retry.
 */
export async function handoffToBot(input: {
  fromBotId: string
  conversationId: string
  toBotName: string
  message: string
}): Promise<{ ok: boolean; text: string }> {
  const conversation = conversationsRepo.get(input.conversationId)
  if (!conversation) return { ok: false, text: 'That conversation no longer exists.' }

  const members = conversationsRepo.members(conversation.id)
  const fromBot = botsRepo.get(input.fromBotId)
  const activeJob = runningJobFor(input.fromBotId, conversation.id)
  const originMessageId = activeJob?.originMessageId ?? null

  const decision = evaluateHandoff({
    request: {
      fromBotId: input.fromBotId,
      toBotName: input.toBotName,
      message: input.message,
      conversationId: conversation.id
    },
    members,
    currentDepth: activeJob?.handoffDepth ?? 0,
    automatedTurnsSoFar: originMessageId ? jobsRepo.countAutomatedForOrigin(originMessageId) : 0,
    settings: settingsRepo.get(),
    // Without the full roster the evaluator cannot tell "no such Bot" from "that
    // Bot exists but is not in this group", and told the model the first — which
    // is false, and sends it off to invent a name instead of asking the human to
    // add the Bot. Hidden/archived members resolve from `members` first, so the
    // visible-only list is the right set here.
    allBots: botsRepo.list()
  })

  if (!decision.allowed || !decision.toBotId) {
    const explanation = handoffDenialText(
      decision.reason,
      input.toBotName,
      // Who this Bot could actually reach instead. Itself excluded: a handoff to
      // self is rejected on its own terms.
      members.filter((member) => member.id !== input.fromBotId).map((member) => member.name)
    )
    // Loop-guard denials are posted so the human can see why the chain stopped
    // (PRD 13.3/13.4). Bad-name mistakes stay between the app and the model.
    if (decision.reason === 'depth' || decision.reason === 'turn-budget') {
      systemMessage(conversation.id, 'loop_guard', explanation, input.fromBotId)
      touchConversation(conversation.id)
    }
    return { ok: false, text: explanation }
  }

  const toBot = members.find((member) => member.id === decision.toBotId)
  // The body is the note ONLY. "Builder → Reviewer" is rendered from the two bot
  // references, so a later rename shows the current names and the transcript
  // never displays raw markdown.
  systemMessage(
    conversation.id,
    'handoff',
    truncateQuote(input.message),
    input.fromBotId,
    toBot ?? null
  )

  enqueueJobs([decision.toBotId], {
    conversationId: conversation.id,
    triggeringMessageId: activeJob?.triggeringMessageId ?? null,
    originMessageId,
    handoffDepth: decision.nextDepth ?? (activeJob?.handoffDepth ?? 0) + 1,
    handoff: {
      fromBotId: input.fromBotId,
      fromBotName: fromBot?.name ?? 'another Bot',
      note: input.message
    }
  })
  touchConversation(conversation.id)

  return {
    ok: true,
    text: `Handed off to ${toBot?.name ?? input.toBotName}. Their reply is posted in this conversation and you will see it the next time you run.`
  }
}

/**
 * Count one `send_message_to_group` call against the running turn's budget.
 *
 * Refused calls are counted too, so `refused-first` fires exactly once per turn
 * and a model that keeps hammering the tool cannot keep posting loop-guard cards.
 * There is no live job when the caller is not inside a turn, which cannot happen
 * through the control server (a grant is minted per turn), so that case is
 * allowed rather than refused against a counter that would never reset.
 */
type GroupPostClaim = 'allowed' | 'refused-first' | 'refused'

function claimGroupPost(jobId: string | null): GroupPostClaim {
  if (jobId === null) return 'allowed'
  const used = (groupPostsByJob.get(jobId) ?? 0) + 1
  // Re-insert so the most recently used counter is the youngest in insertion
  // order, which is what the eviction below relies on.
  groupPostsByJob.delete(jobId)
  groupPostsByJob.set(jobId, used)
  while (groupPostsByJob.size > GROUP_POST_COUNTER_MAX_ENTRIES) {
    const oldest = groupPostsByJob.keys().next()
    if (oldest.done) break
    groupPostsByJob.delete(oldest.value)
  }
  if (used <= MAX_GROUP_POSTS_PER_TURN) return 'allowed'
  return used === MAX_GROUP_POSTS_PER_TURN + 1 ? 'refused-first' : 'refused'
}

/**
 * `mcp__claude_code_bots__send_message_to_group`. Broadcasts into the transcript
 * without waking anyone: fanning out to every member from inside a Bot turn is
 * exactly the ping-pong PRD 13.3 exists to prevent. Other Bots pick the message
 * up through the group context bridge on their next turn.
 *
 * Deliberately NOT gated on `handoffsEnabled`: that switch's own copy promises
 * "Bots still see each other's messages in a group", and a group post wakes
 * nobody, so it is not the "one Bot waking another" the setting describes. What
 * it does get is a per-turn ceiling — see MAX_GROUP_POSTS_PER_TURN for why this
 * one tool needed a counter of its own.
 */
export async function handoffToGroup(input: {
  fromBotId: string
  conversationId: string
  message: string
}): Promise<{ ok: boolean; text: string }> {
  const conversation = conversationsRepo.get(input.conversationId)
  if (!conversation) return { ok: false, text: 'That conversation no longer exists.' }

  const activeJob = runningJobFor(input.fromBotId, conversation.id)
  const claim = claimGroupPost(activeJob?.id ?? null)
  if (claim !== 'allowed') {
    const explanation = `You have already posted ${MAX_GROUP_POSTS_PER_TURN} group messages during this turn, which is the limit. Finish your answer instead — the other Bots will read what you already posted the next time they run.`
    log.warn('conversation', 'group post budget exhausted for this turn', {
      botId: input.fromBotId,
      conversationId: conversation.id,
      jobId: activeJob?.id ?? null
    })
    // Shown once, for the same reason the depth and turn-budget denials are
    // (PRD 13.3/13.4): the human should be able to see why a Bot stopped
    // mid-flood. Returned to the model as a text result rather than a tool
    // error — a tool error just makes it try again.
    if (claim === 'refused-first') {
      systemMessage(conversation.id, 'loop_guard', explanation, input.fromBotId)
      touchConversation(conversation.id)
    }
    return { ok: false, text: explanation }
  }

  const fromBot = botsRepo.get(input.fromBotId)
  const message = messagesRepo.create({
    conversationId: conversation.id,
    authorType: 'bot',
    authorBot: fromBot,
    bodyMarkdown: truncateQuote(input.message),
    status: 'complete'
  })
  emit('message:created', { message })
  touchConversation(conversation.id)

  return {
    ok: true,
    text: 'Posted to the group. The other Bots will see it the next time they run. To ask one Bot to act now, use send_message_to_bot.'
  }
}

/** `mcp__claude_code_bots__list_bots`. */
export async function listBotsInConversation(input: {
  conversationId: string
}): Promise<{ ok: boolean; text: string }> {
  const conversation = conversationsRepo.get(input.conversationId)
  if (!conversation) return { ok: false, text: 'That conversation no longer exists.' }

  const members = conversationsRepo.members(conversation.id)
  if (members.length === 0) return { ok: true, text: 'This conversation has no Bots.' }

  const lines = members.map((bot) => {
    const role = bot.title ? ` — ${bot.title}` : ''
    return `- ${bot.name}${role}`
  })
  return { ok: true, text: `Bots in “${conversation.name}”:\n${lines.join('\n')}` }
}
