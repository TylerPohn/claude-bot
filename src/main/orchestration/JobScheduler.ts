/**
 * The job scheduler: the only place in the app that spawns Claude Code turns
 * (ARCHITECTURE §5, PRD §23).
 *
 * Every other module in this lane is pure. This one owns the side effects:
 * database writes, the runtime, renderer events and notifications. It is
 * deliberately the single choke point for concurrency, because Claude Code turns
 * are expensive in both CPU and the user's subscription allowance, and letting
 * arbitrary call sites spawn them would make the limits unenforceable.
 *
 * Invariants enforced here:
 *   - at most `settings.maxConcurrentBots` Claude processes at once, re-read on
 *     every drain so the user can change the limit while work is queued;
 *   - at most one active job per (bot, conversation) pair, FIFO within the pair;
 *   - a bot never runs in two conversations at once unless the user opted in.
 */
import { randomBytes } from 'node:crypto'

import type { Activity, AppSettings, Bot, BotJob, Conversation, Message, MessageUsage, RateLimitInfo, SystemMessageKind } from '@shared/types'
import type { AppEventMap, AppEventName, RuntimeEvent } from '@shared/types/events'
import type { AgentRuntime, RunTurnInput } from '@main/runtime/types'
import type { MappedActivity } from '@main/runtime/ActivityMapper'
import { mapToolEnd, mapToolStart } from '@main/runtime/ActivityMapper'
import { transaction } from '@main/db/index'
import { activitiesRepo } from '@main/db/repositories/activities'
import { botsRepo } from '@main/db/repositories/bots'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { jobsRepo } from '@main/db/repositories/jobs'
import { messagesRepo } from '@main/db/repositories/messages'
import { sessionsRepo } from '@main/db/repositories/sessions'
import { settingsRepo } from '@main/db/repositories/settings'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'
import { nowIso } from '@main/lib/id'
import { restatAttachments } from './attachments'
import { planDelivery, type DeliveryPlan } from './delivery'
import { buildBridge, buildRecoveryTranscript } from './GroupContextBridge'
import { buildPrompt, type PriorTranscript } from './PromptBuilder'
import { SAFETY_DISALLOWED_TOOLS, mergeToolPatterns } from './guardrails'
import { resolveWorkspace } from './workspace'
/**
 * The MCP handoff tools are appended to every job's allowedTools so Claude can
 * call them without a permission prompt that no human is there to answer
 * (ARCHITECTURE §6). Imported rather than re-declared so the qualified names
 * have exactly one source of truth alongside the tool definitions themselves.
 */
import { HANDOFF_TOOL_NAMES } from '@main/mcp/protocol'
import { recordExit } from '@main/services/DiagnosticsService'

export interface SchedulerDeps {
  runtime: AgentRuntime
  emit: <K extends AppEventName>(name: K, payload: AppEventMap[K]) => void
  notify: (input: {
    conversationId: string
    title: string
    body: string
    level?: 'info' | 'error'
  }) => void
  /**
   * Serialized `--mcp-config` for one job, or null when handoffs are off.
   * Takes the job context because the bridge script is launched with the calling
   * bot's identity baked into its environment. A caller that ignores the argument
   * still satisfies this type.
   */
  mcpConfigJson: (ctx: { botId: string; conversationId: string }) => string | null
}

export interface EnqueueInput {
  botId: string
  conversationId: string
  triggeringMessageId: string | null
  /** Root human message of this chain, for the automated-turn budget. */
  originMessageId: string | null
  handoffDepth: number
  handoff?: { fromBotId: string; fromBotName: string; note: string } | null
}

interface HandoffContext {
  fromBotId: string
  fromBotName: string
  note: string
}

interface PendingJob {
  jobId: string
  botId: string
  conversationId: string
  handoff: HandoffContext | null
}

interface ActiveJob extends PendingJob {
  responseMessageId: string
  cancelled: boolean
  /**
   * Set when the user invalidated this pairing's Claude session while the turn was
   * still in flight (Clear transcript). Both places that persist a session id check
   * it, because either can fire after the destructive IPC handler has returned.
   */
  sessionDiscarded: boolean
  done: Promise<void>
}

/**
 * Streaming deltas arrive one token at a time. Emitting an IPC message and
 * writing to SQLite per token would peg the main process and produce thousands of
 * renderer re-renders for a single reply, so deltas are coalesced to ~30 flushes
 * per second per message with a guaranteed trailing flush.
 */
const DELTA_FLUSH_MS = 33


/** PRD §37 copy, verbatim. Never mention API keys or billing. */
const RATE_LIMIT_TEXT =
  'Claude Code usage limit reached. Your Bot history is safe. Retry after your Claude allowance resets.'

/**
 * The same event reaches the user twice — once as the system card that carries
 * the PRD §37 sentence and the sidebar's "Claude usage limit reached" signal,
 * and once as the failed row's inline error next to Retry. Sending
 * RATE_LIMIT_TEXT to both printed the identical 15 words one line apart, reading
 * like two separate things had gone wrong. The row gets the short label and the
 * card keeps the full copy, exactly as #workspaceMissing already splits them.
 */
const RATE_LIMIT_ROW_TEXT = 'Usage limit reached.'

/** PRD §37 copy, verbatim. */
const SESSION_RECOVERED_TEXT =
  'Started a fresh Claude session because the previous session could not be resumed.'

/** How much local transcript we replay into a session that does not have it. */
const RECOVERY_TRANSCRIPT_CHARS = 6000

const NOTIFICATION_BODY_CHARS = 160

/** Bytes of randomness in the per-prompt structural tag (renders as 8 hex chars). */
const NONCE_BYTES = 4

/**
 * Message statuses `messagesRepo.since()` hides because the row is still being
 * written. A row in one of these states is the read barrier: it will become
 * readable later, so no Bot's watermark may step over it (see ./delivery.ts).
 */
const IN_FLIGHT_STATUSES = new Set<Message['status']>(['queued', 'running', 'streaming'])

/** The permission card names the first backticked token, and clips at 60 chars. */
const DENIAL_LABEL_CHARS = 58

/** Result text that means "you are out of allowance", not "your task failed". */
function looksRateLimited(text: string | null | undefined): boolean {
  if (!text) return false
  return /usage limit|rate limit|rate_limit|too many requests|quota/i.test(text)
}

/**
 * `rate_limit_event.status` is informational most of the time — Claude Code emits
 * `allowed` and `allowed_warning` during normal runs. Only a non-allowed status
 * means the turn is actually being blocked.
 */
function isBlockingRateLimit(info: RateLimitInfo): boolean {
  const status = (info.status ?? '').toLowerCase().trim()
  if (status.length === 0) return false
  return !status.startsWith('allowed') && status !== 'ok'
}

/**
 * The next representable transcript position after `iso`. Ordering is
 * `(created_at, seq)` and `created_at` is millisecond ISO text, so one
 * millisecond is the smallest step that is guaranteed to sort after — `seq` is
 * not an option here because it never reaches the renderer.
 */
function justAfter(iso: string): string {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? nowIso() : new Date(parsed + 1).toISOString()
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n').find((candidate) => candidate.trim().length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

interface TurnOutcome {
  sessionId: string | null
  result: Extract<RuntimeEvent, { type: 'result' }> | null
  streamedText: string
  stderr: string
  rateLimited: boolean
  exitCode: number | null
  exitSignal: string | null
}

export class JobScheduler {
  readonly #deps: SchedulerDeps
  /** Global FIFO of queued jobs. Order is the tie-breaker for every pair rule. */
  readonly #queue: PendingJob[] = []
  readonly #active = new Map<string, ActiveJob>()
  /**
   * Ids handed to a (bot, conversation) pair AHEAD of its durable watermark, keyed
   * by `${botId}\0${conversationId}`.
   *
   * The watermark is a low-water mark that cannot advance past a message another
   * Bot is still writing (see ./delivery.ts), so without this the messages sitting
   * beyond that barrier would be replayed on every turn until the barrier lifted.
   * Process-local on purpose: losing it costs one re-read of context the Bot has
   * already seen, which is exactly what the durable half is there to make safe.
   */
  readonly #deliveredAhead = new Map<string, Set<string>>()
  #disposed = false

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
  }

  /* ---------------------------------------------------------------- *
   * Public surface
   * ---------------------------------------------------------------- */

  enqueue(input: EnqueueInput): BotJob {
    if (this.#disposed) throw new AppError('internal', 'The app is shutting down.')

    const bot = botsRepo.get(input.botId)
    if (!bot) throw new AppError('not_found', 'That Bot no longer exists.')
    const conversation = conversationsRepo.get(input.conversationId)
    if (!conversation) throw new AppError('not_found', 'That conversation no longer exists.')

    // `jobs.response_message_id` and `messages.job_id` point at each other, so one
    // of them has to be filled in a moment after the other. Doing both inside a
    // transaction means no reader ever sees the half-linked state.
    const { job, message } = transaction(() => {
      const created = jobsRepo.create({
        botId: bot.id,
        conversationId: conversation.id,
        triggeringMessageId: input.triggeringMessageId,
        responseMessageId: '',
        originMessageId: input.originMessageId,
        handoffDepth: input.handoffDepth
      })
      const placeholder = messagesRepo.create({
        conversationId: conversation.id,
        authorType: 'bot',
        authorBot: bot,
        bodyMarkdown: '',
        status: 'queued',
        jobId: created.id,
        handoffFromBotId: input.handoff?.fromBotId ?? null
      })
      const linked = jobsRepo.update(created.id, { responseMessageId: placeholder.id })
      return { job: linked, message: placeholder }
    })

    this.#queue.push({
      jobId: job.id,
      botId: bot.id,
      conversationId: conversation.id,
      handoff: input.handoff ?? null
    })

    this.#deps.emit('message:created', { message })
    this.#deps.emit('job:updated', { job })
    this.#emitConversation(conversation.id)
    this.#drain()
    return job
  }

  async stop(jobId: string): Promise<void> {
    const active = this.#active.get(jobId)
    if (active) {
      // Mark first: the streaming loop checks this flag to decide between the
      // "cancelled" and "complete" finalizers.
      active.cancelled = true
      await this.#deps.runtime.cancel(jobId)
      return
    }
    const index = this.#queue.findIndex((pending) => pending.jobId === jobId)
    if (index >= 0) {
      const [pending] = this.#queue.splice(index, 1)
      if (pending) this.#cancelPending(pending)
    }
  }

  async stopConversation(conversationId: string): Promise<void> {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const pending = this.#queue[i]!
      if (pending.conversationId !== conversationId) continue
      this.#queue.splice(i, 1)
      this.#cancelPending(pending)
    }
    const running = [...this.#active.values()].filter(
      (active) => active.conversationId === conversationId
    )
    await Promise.allSettled(running.map((active) => this.stop(active.jobId)))
  }

  /**
   * Mark every in-flight turn in a conversation as "its Claude session has been
   * thrown away", so nothing it does later writes a session id back.
   *
   * Needed because cancelling a turn does not wait for it to unwind. `stop()`
   * resolves as soon as the child PROCESS is dead (see ClaudeCodeRuntime.cancel and
   * ProcessManager's `processGone`), several awaits before the job reaches
   * `#finalize`. So "Clear transcript" during a running turn used to null the
   * session ids and then have the cancelled job's `#finalize` write the very same
   * id straight back — the Bot resumed the session holding the transcript the user
   * had just deleted, which is the exact failure that clearing sessions exists to
   * prevent. A flag on the in-memory job makes the outcome independent of whether
   * the child happens to die before or after the IPC handler returns; draining
   * cannot, because `kill()` allows a wedged child a 15s grace period.
   */
  discardSessions(conversationId: string): void {
    for (const active of this.#active.values()) {
      if (active.conversationId === conversationId) active.sessionDiscarded = true
    }
  }

  /**
   * Stop everything a Bot is doing, everywhere. Called before the Bot row is
   * deleted: a turn that is still streaming would otherwise keep writing rows
   * that reference a bot id the delete is about to remove, and the user would
   * see the resulting constraint failure instead of their answer.
   */
  async stopBot(botId: string): Promise<void> {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const pending = this.#queue[i]!
      if (pending.botId !== botId) continue
      this.#queue.splice(i, 1)
      this.#cancelPending(pending)
    }
    const running = [...this.#active.values()].filter((active) => active.botId === botId)
    await Promise.allSettled(running.map((active) => this.stop(active.jobId)))
  }

  /** Bot ids currently running / queued in a conversation, for the header chips. */
  runningForConversation(conversationId: string): { running: string[]; queued: string[] } {
    const running = [...this.#active.values()]
      .filter((active) => active.conversationId === conversationId)
      .map((active) => active.botId)
    const queued = this.#queue
      .filter((pending) => pending.conversationId === conversationId)
      .map((pending) => pending.botId)
    return { running, queued }
  }

  /**
   * Startup recovery (PRD §37): a job marked `running` in the database after a
   * restart cannot possibly still be executing — its process died with the app.
   * Say so instead of showing a spinner forever, then pick the queue back up.
   */
  recover(): void {
    let orphans: BotJob[] = []
    try {
      orphans = jobsRepo.markOrphansInterrupted()
    } catch (error) {
      log.error('scheduler', 'failed to mark orphaned jobs interrupted', error)
    }

    for (const job of orphans) {
      // The process died with the app, so any tool it had open never reported
      // back. Close those rows before the message settles, or the transcript
      // keeps a spinner (and hides the tool) for the life of the database.
      this.#closeOpenActivities(job.responseMessageId)
      this.#setMessageStatus(
        job.responseMessageId,
        'interrupted',
        'This turn was interrupted when the app quit.'
      )
      this.#deps.emit('job:updated', { job })
      this.#emitConversation(job.conversationId)
    }

    // Queued jobs survived the restart in the database but not in memory, and
    // nothing else will ever pick them up. The handoff note is not restored — it
    // lives in the visible handoff message, which the context bridge replays.
    for (const job of jobsRepo.listQueued()) {
      if (this.#active.has(job.id)) continue
      if (this.#queue.some((pending) => pending.jobId === job.id)) continue
      this.#queue.push({
        jobId: job.id,
        botId: job.botId,
        conversationId: job.conversationId,
        handoff: null
      })
    }

    this.#drain()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const active = [...this.#active.values()]
    for (const job of active) job.cancelled = true
    await Promise.allSettled(active.map((job) => this.#deps.runtime.cancel(job.jobId)))
    // Give the streaming loops a moment to persist their partial text, but never
    // block quit on a wedged child process.
    await Promise.race([
      Promise.allSettled(active.map((job) => job.done)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4000)
        if (typeof timer.unref === 'function') timer.unref()
      })
    ])
  }

  /* ---------------------------------------------------------------- *
   * Queue draining
   * ---------------------------------------------------------------- */

  #drain(): void {
    if (this.#disposed) return

    // Re-read settings on every drain: the user can move the concurrency slider
    // while jobs are waiting, and the next start must honour the new value.
    let settings: AppSettings
    try {
      settings = settingsRepo.get()
    } catch (error) {
      log.error('scheduler', 'could not read settings while draining', error)
      return
    }
    const maxConcurrent = Math.max(1, settings.maxConcurrentBots)

    let index = 0
    while (index < this.#queue.length) {
      if (this.#active.size >= maxConcurrent) return
      const pending = this.#queue[index]!
      if (!this.#canStart(pending, settings)) {
        // Skipping (rather than stopping) keeps other pairs moving while this one
        // waits; FIFO within the pair still holds because the queue is scanned in
        // insertion order, so this job is the first of its pair to become eligible.
        index++
        continue
      }
      this.#queue.splice(index, 1)
      this.#start(pending)
    }
  }

  #canStart(pending: PendingJob, settings: AppSettings): boolean {
    for (const active of this.#active.values()) {
      if (active.botId !== pending.botId) continue
      // One active job per (bot, conversation): a bot must never race itself
      // inside a single transcript.
      if (active.conversationId === pending.conversationId) return false
      // Same bot, different conversation: off by default because two live
      // transcripts from one persona is confusing to watch.
      if (!settings.allowSameBotConcurrentConversations) return false
    }
    return true
  }

  #start(pending: PendingJob): void {
    const job = jobsRepo.get(pending.jobId)
    if (!job) return

    const active: ActiveJob = {
      ...pending,
      responseMessageId: job.responseMessageId,
      cancelled: false,
      sessionDiscarded: false,
      done: Promise.resolve()
    }
    this.#active.set(job.id, active)

    const started = jobsRepo.update(job.id, { status: 'running', startedAt: nowIso() })
    this.#deps.emit('job:updated', { job: started })
    this.#setMessageStatus(job.responseMessageId, 'running')

    active.done = this.#run(active)
      .catch((error: unknown) => {
        log.error('scheduler', `job ${job.id} failed`, error)
        this.#failJob(active, error)
      })
      .finally(() => {
        this.#active.delete(job.id)
        this.#emitConversation(job.conversationId)
        this.#drain()
      })
  }

  /* ---------------------------------------------------------------- *
   * One job
   * ---------------------------------------------------------------- */

  async #run(active: ActiveJob): Promise<void> {
    const settings = settingsRepo.get()
    const bot = botsRepo.get(active.botId)
    const conversation = conversationsRepo.get(active.conversationId)
    const job = jobsRepo.get(active.jobId)
    if (!bot || !conversation || !job) {
      throw new AppError('not_found', 'This Bot or conversation was deleted before it could run.')
    }

    const workspace = resolveWorkspace({
      conversationWorkspace: conversation.workspaceDirectory,
      botWorkspace: bot.defaultWorkingDirectory,
      defaultWorkspace: settings.defaultWorkspace
    })
    if (!workspace.exists) {
      this.#workspaceMissing(active, workspace.path)
      return
    }

    const session = sessionsRepo.get(bot.id, conversation.id)
    const members = conversationsRepo.members(conversation.id)
    const roster = members.map((member) => ({
      id: member.id,
      name: member.name,
      title: member.title
    }))

    // One random tag per prompt build, shared by the bridge labels and the
    // prompt's own section separator. Replayed bodies and handoff notes are
    // arbitrary model output; a marker they have never seen is one they cannot
    // forge, which is what stops one Bot inventing a human turn inside another
    // Bot's prompt.
    const nonce = randomBytes(NONCE_BYTES).toString('hex')

    const deliveredKey = deliveryKey(bot.id, conversation.id)
    const deliveredEarlier = this.#deliveredAhead.get(deliveredKey) ?? new Set<string>()

    // Everything this bot has not seen, oldest first. The placeholder it is about
    // to write into is excluded; the triggering message is kept in this list (so
    // it counts toward the read watermark) but pulled out of the bridge, because
    // it is delivered verbatim as the task instead. Rows already handed over on an
    // earlier turn stay in the list too — they are what the watermark catches up
    // with — but are filtered out of the replay.
    const unseen = messagesRepo.since(conversation.id, session?.lastSeenMessageId ?? null, [
      active.responseMessageId
    ])
    const bridgeSource = unseen.filter(
      (message) => message.id !== job.triggeringMessageId && !deliveredEarlier.has(message.id)
    )

    const bridge =
      conversation.type === 'group'
        ? buildBridge({
            conversationName: conversation.name,
            members: roster,
            selfBotId: bot.id,
            unseen: bridgeSource,
            charBudget: settings.groupBridgeCharBudget,
            nonce
          })
        : {
            text: '',
            truncated: false,
            consumedMessageIds: bridgeSource.map((m) => m.id),
            // A direct chat has no bridge block, so nothing is replayed here and
            // `priorTranscript` below is what has to carry the history. Reporting
            // these ids as consumed is only honest because it does.
            renderedMessageIds: []
          }

    // How far this bot has now read. NOT simply "the newest row we consumed": a
    // message another bot is still streaming sorts BEFORE rows we can read right
    // now, and a watermark that stepped over it would hide it forever once it
    // finished (see ./delivery.ts for the full failure).
    const delivered = new Set(bridge.consumedMessageIds)
    if (job.triggeringMessageId) delivered.add(job.triggeringMessageId)
    for (const id of deliveredEarlier) delivered.add(id)
    const barrier = this.#idsAfterOldestInFlight(conversation.id, active.responseMessageId)
    const plan = planDelivery({
      previousLastSeenId: session?.lastSeenMessageId ?? null,
      unseen,
      delivered,
      // A barrier we could not compute has to be assumed to sit before everything:
      // re-reading context is cheap, losing a teammate's reply is not.
      afterBarrier: barrier ?? new Set(unseen.map((message) => message.id))
    })

    // Local history the bridge above does NOT already carry, oldest first, minus the
    // triggering message (`taskLayer` delivers that verbatim). Budget-dropped rows
    // are deliberately not subtracted: dropping them from the bridge is permanent,
    // so this replay is their last chance — see BridgeResult.renderedMessageIds.
    const replayedByBridge = new Set(bridge.renderedMessageIds)
    const fullHistory = (): Message[] =>
      messagesRepo
        .since(conversation.id, null, [active.responseMessageId])
        .filter((message) => !replayedByBridge.has(message.id))
        .filter((message) => message.id !== job.triggeringMessageId)
    const replay = (messages: Message[]): string =>
      buildRecoveryTranscript({
        messages,
        members: roster,
        selfBotId: bot.id,
        charBudget: RECOVERY_TRANSCRIPT_CHARS,
        nonce
      })

    /**
     * PRD §7.4: with no `claude_session_id` there is nothing on Claude's side that
     * remembers this conversation, so the prompt has to carry the history itself.
     *
     * This used to happen ONLY inside the `session_not_found` retry below, which a
     * cold session can never reach — there is no `--resume` to fail. So a 1:1 Bot
     * whose session was missing (a restored backup: ExportService never exports
     * `bot_conversation_sessions`; or a first turn that died before Claude emitted
     * its init event) answered with total amnesia in front of a full transcript,
     * and `#finalize` then marked every one of those messages seen, so they could
     * never be delivered by any later turn either. Groups mostly self-healed
     * because the bridge replays from the watermark; direct chats had no bridge at
     * all, and a cleared session keeps its watermark (see `clearSession`), so both
     * types can need this.
     */
    const priorTranscript = ((): PriorTranscript | null => {
      if (!session?.claudeSessionId) {
        const text = replay(fullHistory())
        // '' would still print the recovery framing, which is wrong on a genuinely
        // fresh chat that has no history to reproduce.
        return text.length > 0 ? { text, reason: 'cold_start' } : null
      }
      // A live session already holds everything that was ever sent to it. In a group
      // the bridge covers anything that was not; a direct chat renders no bridge, so
      // a message left unseen by a turn that died before reaching Claude (missing
      // workspace, unusable CLI) would be marked consumed without ever having been
      // delivered to anything.
      if (conversation.type === 'group') return null
      // This bot's OWN replies are excluded, and that exclusion is load-bearing:
      // a completed turn's watermark stops at the message that triggered it, so its
      // own reply row is unseen on the next turn and would be replayed verbatim on
      // EVERY follow-up — re-billing the model for text it wrote itself and already
      // has in session. Only what the session cannot have is worth the tokens.
      const text = replay(bridgeSource.filter((message) => message.authorBotId !== bot.id))
      return text.length > 0 ? { text, reason: 'undelivered' } : null
    })()

    const userMessage = job.triggeringMessageId ? messagesRepo.get(job.triggeringMessageId) : null
    const replyTo = userMessage?.replyToMessageId
      ? messagesRepo.get(userMessage.replyToMessageId)
      : null
    // PRD §17.1: attachments are paths, not copies, and this turn may have waited
    // in the queue (or been retried hours later) since the user picked them. Stat
    // them once here and use the same answer for both prompt builds below, so the
    // prompt never asserts a path that is not there any more.
    const attachments = restatAttachments(userMessage?.attachments ?? [])

    const mcpConfigJson = this.#deps.mcpConfigJson({
      botId: bot.id,
      conversationId: conversation.id
    })

    const runInput: RunTurnInput = {
      jobId: active.jobId,
      prompt: buildPrompt({
        bot,
        conversation,
        isFirstTurnInSession: !session?.claudeSessionId,
        bridge: bridge.text.length > 0 ? bridge.text : null,
        userMessage,
        replyTo,
        attachments,
        memberNames: members.map((member) => member.name),
        handoff: active.handoff
          ? { fromBotName: active.handoff.fromBotName, note: active.handoff.note }
          : null,
        workspace: workspace.path,
        priorTranscript,
        nonce
      }),
      cwd: workspace.path,
      resumeSessionId: session?.claudeSessionId ?? null,
      // 'default' means "use whatever the user configured in Claude Code itself",
      // so a bot-level 'default' falls through to the app default, which may also
      // be 'default' — the runtime then omits the flag entirely.
      model: bot.model !== 'default' ? bot.model : settings.defaultModel,
      permissionMode:
        bot.permissionMode !== 'default' ? bot.permissionMode : settings.defaultPermissionMode,
      allowedTools: mergeToolPatterns(
        settings.globalAllowedTools,
        bot.allowedTools,
        mcpConfigJson ? HANDOFF_TOOL_NAMES : []
      ),
      disallowedTools: mergeToolPatterns(
        settings.globalDisallowedTools,
        bot.disallowedTools,
        settings.safetyGuardrails ? SAFETY_DISALLOWED_TOOLS : []
      ),
      mcpConfigJson,
      includePartialMessages: true
    }

    let outcome = await this.#executeTurn(active, runInput, bot, settings)

    // Session recovery, at most once per job (PRD §37). A second failure is a real
    // failure — retrying forever would loop on a broken install.
    if (!active.cancelled && outcome.result?.subtype === 'session_not_found') {
      log.warn('scheduler', `session could not be resumed for job ${active.jobId}`)
      sessionsRepo.clearSession(bot.id, conversation.id)

      // The recovery prompt keeps the bridge (it carries the roster, the "respond
      // to the newest message addressed to you" instruction and the nonce
      // anti-forgery rule) and adds the older history the bridge does not cover.
      // Those two used to overlap completely: every backlog line was billed twice
      // in one prompt — 23-39% of the recovered prompt measured — and the model
      // was handed the same teammate messages under two contradictory framings,
      // one saying it had taken part in them and one saying it had not seen them.
      // `fullHistory` does that subtraction, and the triggering message's too:
      // `taskLayer` delivers that verbatim, which was a third copy.
      const recoveryInput: RunTurnInput = {
        ...runInput,
        resumeSessionId: null,
        prompt: buildPrompt({
          bot,
          conversation,
          isFirstTurnInSession: true,
          bridge: bridge.text.length > 0 ? bridge.text : null,
          userMessage,
          replyTo,
          attachments,
          memberNames: members.map((member) => member.name),
          handoff: active.handoff
            ? { fromBotName: active.handoff.fromBotName, note: active.handoff.note }
            : null,
          workspace: workspace.path,
          // Kept non-null even when empty: the framing ("this is a fresh session")
          // still has to be sent, or the recreated session re-introduces itself.
          priorTranscript: { text: replay(fullHistory()), reason: 'resume_failed' },
          nonce
        })
      }

      // The failed attempt may have written a fragment before erroring out.
      messagesRepo.setBody(active.responseMessageId, '')
      // Its completed activities stay — an Edit it really made is a fact about
      // the user's disk — but anything it left in flight will never report back,
      // so close it here rather than letting the retried turn render an
      // abandoned attempt's perpetual spinner underneath its own cards.
      this.#closeOpenActivities(active.responseMessageId)

      // The notice explains the reply that FOLLOWS it, so it has to sort above
      // that reply. The reply row was created at enqueue time, long before this
      // turn came back `session_not_found`, and every read path orders by
      // (created_at, seq) — so a notice written now landed underneath the answer
      // and read as a warning about the next turn instead of this one. The
      // recovered attempt genuinely restarts here, so the reply row is re-stamped
      // to just after the notice. Back-dating the notice instead cannot work: the
      // user's triggering message is routinely written in the same millisecond as
      // the placeholder, so there is no timestamp between them to use.
      const notice = this.#system(conversation.id, 'session_recovered', SESSION_RECOVERED_TEXT)
      messagesRepo.setCreatedAt(active.responseMessageId, justAfter(notice.createdAt))
      // The emit is not optional: without it the database is cleared but the
      // renderer keeps rendering the dead session's fragment as the Bot's reply
      // for the whole of the retry's pre-text phase (unbounded — a retry that
      // runs tools for minutes holds it until #finalize), in the old position.
      this.#emitMessage(active.responseMessageId)
      outcome = await this.#executeTurn(active, recoveryInput, bot, settings)
    }

    this.#finalize(active, bot, conversation, outcome, plan)
  }

  /**
   * Runs one Claude turn and drains its event stream. Returns what happened; it
   * never decides the job's fate, so the caller can retry cleanly.
   */
  async #executeTurn(
    active: ActiveJob,
    input: RunTurnInput,
    bot: Bot,
    settings: AppSettings
  ): Promise<TurnOutcome> {
    const messageId = active.responseMessageId
    const conversationId = active.conversationId

    const outcome: TurnOutcome = {
      sessionId: null,
      result: null,
      streamedText: '',
      stderr: '',
      rateLimited: false,
      exitCode: null,
      exitSignal: null
    }

    /* ---- coalesced delta writer ---- */
    let pendingText = ''
    let pendingThinking = ''
    let flushTimer: NodeJS.Timeout | null = null
    let lastFlush = 0
    let markedStreaming = false

    const flush = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      lastFlush = Date.now()
      if (pendingText.length === 0 && pendingThinking.length === 0) return
      const textDelta = pendingText
      const thinkingDelta = pendingThinking
      pendingText = ''
      pendingThinking = ''
      try {
        // One append per flush, not one per token: this is the hot path.
        if (textDelta.length > 0) messagesRepo.appendText(messageId, textDelta)
        if (thinkingDelta.length > 0) messagesRepo.appendThinking(messageId, thinkingDelta)
      } catch (error) {
        log.error('scheduler', 'failed to append streamed text', error)
      }
      this.#deps.emit('message:delta', {
        messageId,
        conversationId,
        textDelta: textDelta.length > 0 ? textDelta : undefined,
        thinkingDelta: thinkingDelta.length > 0 ? thinkingDelta : undefined
      })
    }

    const schedule = (): void => {
      const elapsed = Date.now() - lastFlush
      if (elapsed >= DELTA_FLUSH_MS) {
        flush()
        return
      }
      if (flushTimer !== null) return
      // Trailing flush: the last few tokens of a reply must never be stranded in
      // the buffer just because the stream went quiet.
      flushTimer = setTimeout(flush, DELTA_FLUSH_MS - elapsed)
      if (typeof flushTimer.unref === 'function') flushTimer.unref()
    }

    /* ---- tool activity bookkeeping ---- */
    const startedTools = new Map<string, MappedActivity>()

    try {
      for await (const event of this.#deps.runtime.runTurn(input)) {
        switch (event.type) {
          case 'session': {
            outcome.sessionId = event.sessionId
            // Persist as soon as it is known: if the app dies mid-turn the session
            // is still resumable next launch. Unless the user cleared the transcript
            // while this turn was running — then the session is exactly what they
            // asked to forget, and Claude Code's init event can easily arrive after
            // the clear. The job row still records what actually ran.
            if (!active.sessionDiscarded) {
              sessionsRepo.upsertSessionId(active.botId, conversationId, event.sessionId)
            }
            jobsRepo.update(active.jobId, { claudeSessionId: event.sessionId })
            break
          }
          case 'text_delta': {
            if (!markedStreaming) {
              markedStreaming = true
              this.#setMessageStatus(messageId, 'streaming')
            }
            outcome.streamedText += event.text
            pendingText += event.text
            schedule()
            break
          }
          case 'thinking_delta': {
            // Only stored when the user asked to see thinking; otherwise it is
            // pure write amplification for text nothing will ever render.
            if (!settings.showThinking) break
            pendingThinking += event.text
            schedule()
            break
          }
          case 'text_block': {
            // The parser only emits text the deltas did not already carry.
            if (event.text.length === 0) break
            if (!markedStreaming) {
              markedStreaming = true
              this.#setMessageStatus(messageId, 'streaming')
            }
            outcome.streamedText += event.text
            pendingText += event.text
            flush()
            break
          }
          case 'tool_start': {
            flush() // keep text written before the tool call ordered before it
            const mapped = mapToolStart(event.name, event.input, input.cwd)
            startedTools.set(event.toolUseId, mapped)
            const activity = activitiesRepo.create({
              messageId,
              botId: active.botId,
              type: mapped.type,
              title: mapped.title,
              subtitle: mapped.subtitle,
              detail: mapped.detail,
              toolName: mapped.toolName,
              toolUseId: event.toolUseId,
              status: 'running',
              addedLines: null,
              removedLines: null
            })
            this.#deps.emit('activity:created', { activity })
            break
          }
          case 'tool_end': {
            const started = startedTools.get(event.toolUseId)
            const patch = started
              ? mapToolEnd(started, {
                  isError: event.isError,
                  content: event.content,
                  structured: event.structured
                })
              : { subtitle: null, detail: event.content, addedLines: null, removedLines: null }
            const activity: Activity | null = activitiesRepo.finish(event.toolUseId, {
              status: event.isError ? 'error' : 'success',
              ...patch
            })
            if (activity) this.#deps.emit('activity:updated', { activity })
            break
          }
          case 'rate_limit': {
            this.#deps.emit('runtime:rateLimit', event.info)
            if (isBlockingRateLimit(event.info)) outcome.rateLimited = true
            break
          }
          case 'result': {
            outcome.result = event
            if (event.sessionId) outcome.sessionId = event.sessionId
            if (event.isError && looksRateLimited(event.resultText)) outcome.rateLimited = true
            break
          }
          case 'stderr': {
            outcome.stderr += event.text
            break
          }
          case 'exit': {
            outcome.exitCode = event.code
            outcome.exitSignal = event.signal
            // Feeds DiagnosticsReport.recentExitCodes, which the Copy
            // diagnostics button surfaces when a user reports a stuck Bot.
            recordExit(active.jobId, event.code, event.signal)
            break
          }
          case 'parse_error': {
            // Already counted by the parser; a malformed line must not kill a turn.
            log.warn('scheduler', 'malformed stream line', { jobId: active.jobId })
            break
          }
          case 'status':
            break
        }
        if (active.cancelled) {
          // The process is already being torn down by stop(); stop consuming so
          // finalization can keep whatever text arrived.
          break
        }
      }
    } finally {
      flush()
    }

    return outcome
  }

  /* ---------------------------------------------------------------- *
   * Finalization
   * ---------------------------------------------------------------- */

  #finalize(
    active: ActiveJob,
    bot: Bot,
    conversation: Conversation,
    outcome: TurnOutcome,
    plan: DeliveryPlan
  ): void {
    const messageId = active.responseMessageId
    const completedAt = nowIso()

    if (outcome.sessionId && !active.sessionDiscarded) {
      // Even a cancelled turn leaves a resumable session behind — keeping it is
      // strictly better than orphaning it and starting cold next time. The one
      // exception is a session the user threw away mid-turn; see `discardSessions`.
      sessionsRepo.upsertSessionId(bot.id, conversation.id, outcome.sessionId)
    }

    if (active.cancelled) {
      // Partial text stays visible, and the read watermark is deliberately NOT
      // advanced: this bot never finished reading the backlog it was given.
      this.#closeOpenActivities(messageId)
      this.#setMessageStatus(messageId, 'cancelled')
      const job = jobsRepo.update(active.jobId, {
        status: 'cancelled',
        completedAt,
        exitCode: outcome.exitCode,
        exitSignal: outcome.exitSignal
      })
      this.#deps.emit('job:updated', { job })
      return
    }

    if (outcome.rateLimited) {
      this.#system(conversation.id, 'rate_limit', RATE_LIMIT_TEXT)
      this.#finishWithError(active, RATE_LIMIT_ROW_TEXT, outcome, completedAt)
      // An OS notification is a separate channel with no card next to it, so it
      // still wants the whole sentence.
      this.#deps.notify({
        conversationId: conversation.id,
        title: bot.name,
        body: RATE_LIMIT_TEXT,
        level: 'error'
      })
      return
    }

    const result = outcome.result

    // A refused tool is the one failure the user can actually fix, and the app
    // ships its own --disallowedTools guardrails, so denials are routine rather
    // than hypothetical (PRD §15.2). Reported before the error branch below,
    // because an errored result can carry denials too.
    if (result) this.#reportPermissionDenials(bot, conversation, result)

    if (!result || result.isError) {
      const detail =
        result?.resultText?.trim() ||
        outcome.stderr.trim() ||
        (outcome.exitSignal
          ? `Claude Code stopped (${outcome.exitSignal}).`
          : `Claude Code exited with code ${outcome.exitCode ?? 'unknown'}.`)
      this.#finishWithError(active, detail, outcome, completedAt)
      this.#deps.notify({
        conversationId: conversation.id,
        title: bot.name,
        body: firstLine(detail, NOTIFICATION_BODY_CHARS) || 'That turn failed.',
        level: 'error'
      })
      return
    }

    // Prefer the streamed text: it is what the user watched appear. `result.result`
    // is the same text in the normal case and a useful fallback when a turn
    // produced only tool calls.
    const finalText =
      outcome.streamedText.trim().length > 0 ? outcome.streamedText : (result.resultText ?? '')
    // Even a clean turn can leave an activity open — a `tool_result` lost to a
    // malformed stream line has no other way of ever being closed, and the whole
    // event stream has been drained by the time we get here, so nothing is still
    // legitimately running. Settling them keeps the rule simple: a message that
    // is no longer live has no running steps.
    this.#closeOpenActivities(messageId)
    messagesRepo.setBody(messageId, finalText)
    messagesRepo.setUsage(messageId, toUsage(result))
    messagesRepo.setStatus(messageId, 'complete')
    this.#emitMessage(messageId)

    // The backlog was delivered, so this bot has now "seen" it.
    sessionsRepo.setLastSeen(bot.id, conversation.id, plan.lastSeenMessageId)
    this.#rememberDeliveredAhead(bot.id, conversation.id, plan.seenAheadIds)

    const job = jobsRepo.update(active.jobId, {
      status: 'success',
      completedAt,
      claudeSessionId: outcome.sessionId,
      exitCode: outcome.exitCode,
      exitSignal: outcome.exitSignal
    })
    this.#deps.emit('job:updated', { job })

    // NotificationService decides whether this is actually shown (focused
    // conversation, notifications disabled, …) — that policy is not ours.
    this.#deps.notify({
      conversationId: conversation.id,
      title: bot.name,
      body: firstLine(finalText, NOTIFICATION_BODY_CHARS) || 'Finished.',
      level: 'info'
    })
  }

  #finishWithError(
    active: ActiveJob,
    detail: string,
    outcome: TurnOutcome,
    completedAt: string
  ): void {
    // Partial output is kept: a crashed or refused turn often still contains the
    // most useful half of the answer (PRD §37). The tool that was in flight when
    // it died is part of that record — see #closeOpenActivities. Routing every
    // failure through here covers the rate-limit branch, the errored-result
    // branch, #failJob and #workspaceMissing in one place.
    this.#closeOpenActivities(active.responseMessageId)
    this.#setMessageStatus(active.responseMessageId, 'error', detail)
    const job = jobsRepo.update(active.jobId, {
      status: 'error',
      completedAt,
      errorText: detail,
      exitCode: outcome.exitCode,
      exitSignal: outcome.exitSignal
    })
    this.#deps.emit('job:updated', { job })
  }

  /** Last-resort handler for a throw anywhere in #run. */
  #failJob(active: ActiveJob, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      this.#finishWithError(
        active,
        detail,
        {
          sessionId: null,
          result: null,
          streamedText: '',
          stderr: '',
          rateLimited: false,
          exitCode: null,
          exitSignal: null
        },
        nowIso()
      )
    } catch (nested) {
      log.error('scheduler', 'failed to record job failure', nested)
    }
  }

  #workspaceMissing(active: ActiveJob, path: string): void {
    // The path itself goes in `errorText` (the red row); repeating it in the
    // card body printed it twice, one line apart.
    const text = 'Set a workspace for this conversation (or for this Bot) and send the message again.'
    this.#system(active.conversationId, 'workspace_missing', text)
    this.#finishWithError(
      active,
      `Working directory not found: ${path}`,
      {
        sessionId: null,
        result: null,
        streamedText: '',
        stderr: '',
        rateLimited: false,
        exitCode: null,
        exitSignal: null
      },
      nowIso()
    )
  }

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  /** Cancels a job that never started: no process to kill, just bookkeeping. */
  #cancelPending(pending: PendingJob): void {
    const job = jobsRepo.get(pending.jobId)
    if (!job) return
    this.#setMessageStatus(job.responseMessageId, 'cancelled')
    const cancelled = jobsRepo.update(pending.jobId, {
      status: 'cancelled',
      completedAt: nowIso()
    })
    this.#deps.emit('job:updated', { job: cancelled })
    this.#emitConversation(pending.conversationId)
  }

  /**
   * `authorBot` matters for more than decoration: the permission card keys both
   * its title and its "Edit allowed tools" action off `authorBotId`, and renders
   * the action disabled without it.
   */
  #system(
    conversationId: string,
    kind: SystemMessageKind,
    body: string,
    authorBot: Bot | null = null
  ): Message {
    const message = messagesRepo.create({
      conversationId,
      authorType: 'system',
      authorBot,
      bodyMarkdown: body,
      status: 'complete',
      systemKind: kind
    })
    this.#deps.emit('message:created', { message })
    return message
  }

  #setMessageStatus(messageId: string, status: Message['status'], errorText?: string): void {
    if (messageId.length === 0) return
    try {
      messagesRepo.setStatus(messageId, status, errorText ?? null)
      this.#emitMessage(messageId)
    } catch (error) {
      log.error('scheduler', 'failed to set message status', error)
    }
  }

  #emitMessage(messageId: string): void {
    if (messageId.length === 0) return
    const message = messagesRepo.get(messageId)
    if (message) this.#deps.emit('message:updated', { message })
  }

  /**
   * Settle a message's in-flight tool calls, because nothing else ever will.
   *
   * An activity is opened by `tool_start` and only ever closed by the matching
   * `tool_end`. A turn that is stopped, fails, or dies with the app never
   * delivers that result, so the row stayed `running` with no end time — and the
   * transcript hides running rows once the turn is over (they belong to the live
   * working indicator while it runs). The effect was that pressing Stop during a
   * `Bash` erased that command from the record, permanently and across restarts,
   * on a message whose footer says actions may already have completed.
   *
   * Called from every terminal path: the cancel branch, #finishWithError (which
   * covers the rate-limit, errored-result, workspace-missing and #failJob
   * routes), startup recovery of interrupted jobs, and the session-recovery
   * reset. It must never throw: a failure to tidy the timeline cannot be allowed
   * to take down the finalization that records the turn itself.
   *
   * The rows land on `cancelled`, not `error`: the tool did not fail, we stopped
   * watching it. `ActivityStrip` reads that as "— stopped" and keeps it out of
   * the failure count. It stays a complement to the renderer's own guard for a
   * row left at 'running' on a settled message — that guard makes the UI robust
   * to a path that forgets to sweep, but only this write keeps the DATABASE (and
   * therefore the export, and every future reload) an honest record.
   */
  #closeOpenActivities(messageId: string): void {
    if (messageId.length === 0) return
    try {
      for (const activity of activitiesRepo.abandonOpen(messageId)) {
        this.#deps.emit('activity:updated', { activity })
      }
    } catch (error) {
      log.error('scheduler', 'failed to close in-flight activities', error)
    }
  }

  /**
   * Ids of messages that sort strictly after the oldest message still being
   * written in this conversation, or null when that could not be determined.
   *
   * `Message` does not carry `seq`, and `(created_at, seq)` is the only correct
   * ordering, so rather than half-comparing on timestamps this asks the same
   * cursor the repository uses: `since(barrier)` IS "everything after the
   * barrier". Only the OLDEST in-flight row matters; candidates sharing its
   * millisecond cannot be ranked from `created_at` alone, so each of those is
   * asked and the answers unioned (a later barrier's answer is a subset of an
   * earlier one's, which is why the rest can be skipped).
   *
   * This bot's own placeholder is not a barrier: it is excluded from its own
   * backlog anyway, and treating it as one would pin every watermark in a
   * one-bot conversation forever.
   */
  #idsAfterOldestInFlight(conversationId: string, selfMessageId: string): Set<string> | null {
    try {
      const candidates: Message[] = []
      for (const job of jobsRepo.activeForConversation(conversationId)) {
        if (job.responseMessageId.length === 0) continue
        if (job.responseMessageId === selfMessageId) continue
        const message = messagesRepo.get(job.responseMessageId)
        // Only a row `since()` would actually hide can hide behind the watermark.
        if (message && IN_FLIGHT_STATUSES.has(message.status)) candidates.push(message)
      }

      const after = new Set<string>()
      if (candidates.length === 0) return after

      let oldest = candidates[0]!.createdAt
      for (const candidate of candidates) {
        if (candidate.createdAt < oldest) oldest = candidate.createdAt
      }
      for (const candidate of candidates) {
        if (candidate.createdAt !== oldest) continue
        for (const message of messagesRepo.since(conversationId, candidate.id)) {
          after.add(message.id)
        }
      }
      return after
    } catch (error) {
      log.error('scheduler', 'could not determine the in-flight read barrier', error)
      return null
    }
  }

  #rememberDeliveredAhead(botId: string, conversationId: string, ids: string[]): void {
    const key = deliveryKey(botId, conversationId)
    // The watermark caught up with everything else, so only these need remembering.
    if (ids.length === 0) this.#deliveredAhead.delete(key)
    else this.#deliveredAhead.set(key, new Set(ids))
  }

  /** PRD §15.2: turn a refused tool into the card that offers a way out. */
  #reportPermissionDenials(
    bot: Bot,
    conversation: Conversation,
    result: Extract<RuntimeEvent, { type: 'result' }>
  ): void {
    const denials = readPermissionDenials(result.permissionDenials)
    if (denials.length === 0) return
    // The card names the FIRST backticked token, so the tool has to lead each line.
    const body = denials
      .map((denial) => `\`${denial}\` was denied under the current permission mode.`)
      .join('\n')
    this.#system(conversation.id, 'permission_denied', body, bot)
  }

  #emitConversation(conversationId: string): void {
    try {
      const conversation = conversationsRepo.getSummary(conversationId)
      if (conversation) this.#deps.emit('conversation:updated', { conversation })
    } catch (error) {
      log.error('scheduler', 'failed to emit conversation summary', error)
    }
  }
}

function deliveryKey(botId: string, conversationId: string): string {
  return `${botId}\u0000${conversationId}`
}

/**
 * `RuntimeEvent.result.permissionDenials` is `unknown[]` — the parser lifts the
 * `permission_denials` array off the result line without inspecting it. Read the
 * two fields Claude Code actually sends, and skip anything malformed rather than
 * showing the user a card about "undefined".
 */
function readPermissionDenials(raw: unknown[]): string[] {
  const labels: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const toolName = typeof record.tool_name === 'string' ? record.tool_name.trim() : ''
    if (toolName.length === 0) continue
    const detail = denialDetail(record.tool_input)
    const label = detail === null ? toolName : `${toolName}(${detail})`
    labels.push(
      label.length > DENIAL_LABEL_CHARS ? `${label.slice(0, DENIAL_LABEL_CHARS)}…` : label
    )
  }
  return labels
}

/** The one field of a refused tool call worth naming, in the order they matter. */
function denialDetail(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function toUsage(result: Extract<RuntimeEvent, { type: 'result' }>): MessageUsage | null {
  if (!result.usage) return null
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadInputTokens: result.usage.cacheReadInputTokens,
    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    model: result.model
  }
}

/* ------------------------------------------------------------------ *
 * Process-wide singleton
 * ------------------------------------------------------------------ */

let scheduler: JobScheduler | null = null

export function initScheduler(deps: SchedulerDeps): JobScheduler {
  scheduler = new JobScheduler(deps)
  return scheduler
}

export function getScheduler(): JobScheduler {
  if (!scheduler) {
    throw new AppError('internal', 'The job scheduler has not been initialized yet.')
  }
  return scheduler
}
