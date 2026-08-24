import { create } from 'zustand'

import type {
  Activity,
  AppSettings,
  Bot,
  BotJob,
  ConversationSummary,
  Message,
  RuntimeStatus
} from '@shared/types'
import type { SendMessageResult } from '@shared/types/api'
import type {
  BotDraftInput,
  BotPatchInput,
  ConversationPatchInput,
  CreateGroupInput,
  SendMessageInput,
  SettingsPatchInput
} from '@shared/schemas'
import { bridge, call, withToast } from '@/lib/ipc'
import { useUiStore } from '@/stores/uiStore'

/**
 * Server-ish state: the roster, the conversation list, loaded transcripts,
 * settings and runtime health. Everything arrives either from an explicit IPC
 * call or from a main-process event, and every event has exactly one reducer.
 */

const PAGE_SIZE = 80

export interface Pagination {
  cursor: string | null
  hasMore: boolean
  loading: boolean
}

export interface AppState {
  /* ---- data ---- */
  bots: Record<string, Bot>
  botOrder: string[]
  conversations: Record<string, ConversationSummary>
  conversationOrder: string[]
  messages: Record<string, Message[]>
  pagination: Record<string, Pagination>
  jobs: Record<string, BotJob>
  /** Extended-thinking text, keyed by message id. Never merged into the body. */
  thinking: Record<string, string>
  settings: AppSettings | null
  runtime: RuntimeStatus | null
  ready: boolean
  bootError: string | null

  /* ---- selectors ---- */
  botsFor(conversationId: string): Bot[]
  conversationTitle(conversationId: string): string
  isBotBusy(botId: string): boolean

  /* ---- actions ---- */
  bootstrap(): Promise<void>
  refreshBots(): Promise<void>
  refreshConversations(): Promise<void>
  loadMessages(conversationId: string): Promise<void>
  loadOlder(conversationId: string): Promise<void>
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
  confirmEveryone(input: SendMessageInput, remember: boolean): Promise<SendMessageResult>
  cancelEveryone(conversationId: string): Promise<void>
  retryMessage(messageId: string): Promise<void>
  stopJob(jobId: string): Promise<void>
  stopConversation(conversationId: string): Promise<void>
  react(messageId: string, emoji: string): Promise<void>
  deleteMessage(messageId: string): Promise<void>
  markRead(conversationId: string): Promise<void>

  createBot(input: BotDraftInput): Promise<Bot>
  updateBot(id: string, patch: BotPatchInput): Promise<Bot>
  duplicateBot(id: string): Promise<Bot>
  setBotPinned(id: string, pinned: boolean): Promise<void>
  setBotHidden(id: string, hidden: boolean): Promise<void>
  deleteBot(id: string): Promise<void>

  createDirect(botId: string): Promise<ConversationSummary>
  createGroup(input: CreateGroupInput): Promise<ConversationSummary>
  updateConversation(id: string, patch: ConversationPatchInput): Promise<ConversationSummary>
  deleteConversation(id: string): Promise<void>

  updateSettings(patch: SettingsPatchInput): Promise<void>
  recheckRuntime(): Promise<void>
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Pinned first, then by name. */
function orderBots(bots: Record<string, Bot>): string[] {
  return Object.values(bots)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return collator.compare(a.name, b.name)
    })
    .map((b) => b.id)
}

/** Pinned first, then most recent activity. A conversation with no messages
 *  sorts by when it was created so a brand-new Bot appears at the top. */
function orderConversations(conversations: Record<string, ConversationSummary>): string[] {
  return Object.values(conversations)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const at = a.lastMessageAt ?? a.createdAt
      const bt = b.lastMessageAt ?? b.createdAt
      if (at !== bt) return at < bt ? 1 : -1
      return collator.compare(a.name, b.name)
    })
    .map((c) => c.id)
}

/* ------------------------------------------------------------------ *
 * Message-id → conversation-id index
 *
 * `activity:created` carries a messageId but no conversationId, and scanning
 * every loaded transcript for the owning message on every tool event would be
 * O(messages) at ~10 events/second. The index makes it O(1).
 * ------------------------------------------------------------------ */

const messageConversation = new Map<string, string>()

function indexMessages(list: Message[]): void {
  for (const m of list) messageConversation.set(m.id, m.conversationId)
}

/**
 * Replace exactly one message inside one conversation's array, leaving every
 * other array identity intact. `MessageRow` is memoized on the message object,
 * so only the row that actually changed re-renders — the requirement that makes
 * 30 deltas/second across a 500-message transcript viable.
 */
function replaceMessage(
  state: AppState,
  conversationId: string,
  messageId: string,
  update: (message: Message) => Message
): Partial<AppState> | null {
  const list = state.messages[conversationId]
  if (!list) return null
  const index = list.findIndex((m) => m.id === messageId)
  if (index === -1) return null
  const next = list.slice()
  next[index] = update(list[index]!)
  return { messages: { ...state.messages, [conversationId]: next } }
}

/** Transcripts are oldest-first; a message that arrives out of order is rare but
 *  must not corrupt the ordering, so it is spliced into place. */
function insertMessage(list: Message[], message: Message): Message[] {
  if (list.length === 0) return [message]
  const last = list[list.length - 1]!
  if (message.createdAt >= last.createdAt) return [...list, message]
  const index = list.findIndex((m) => m.createdAt > message.createdAt)
  const next = list.slice()
  next.splice(index === -1 ? list.length : index, 0, message)
  return next
}

function upsertActivity(message: Message, activity: Activity): Message {
  const index = message.activities.findIndex((a) => a.id === activity.id)
  if (index === -1) {
    const activities = [...message.activities, activity].sort((a, b) => a.seq - b.seq)
    return { ...message, activities }
  }
  const activities = message.activities.slice()
  activities[index] = activity
  return { ...message, activities }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/** Returns a copy of `record` without `key`. Used to prune per-message buffers. */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const k of Object.keys(record)) {
    if (k !== key) next[k] = record[k]!
  }
  return next
}

/** Last rate-limit window we warned about, so one limit yields one toast. */
let lastRateLimitKey: string | null = null

export const useAppStore = create<AppState>()((set, get) => ({
  bots: {},
  botOrder: [],
  conversations: {},
  conversationOrder: [],
  messages: {},
  pagination: {},
  jobs: {},
  thinking: {},
  settings: null,
  runtime: null,
  ready: false,
  bootError: null,

  /* ---- selectors --------------------------------------------------- */

  botsFor(conversationId) {
    const state = get()
    const conversation = state.conversations[conversationId]
    if (!conversation) return []
    const out: Bot[] = []
    for (const id of conversation.memberBotIds) {
      const bot = state.bots[id]
      if (bot) out.push(bot)
    }
    return out
  },

  conversationTitle(conversationId) {
    const state = get()
    const conversation = state.conversations[conversationId]
    if (!conversation) return ''
    if (conversation.type === 'direct') {
      // A direct chat is named after its Bot, so a rename is reflected instantly
      // rather than waiting for main to rewrite the conversation row.
      const bot = state.bots[conversation.memberBotIds[0] ?? '']
      if (bot) return bot.name
    }
    return conversation.name
  },

  isBotBusy(botId) {
    const state = get()
    for (const job of Object.values(state.jobs)) {
      if (job.botId === botId && (job.status === 'running' || job.status === 'queued')) return true
    }
    for (const conversation of Object.values(state.conversations)) {
      if (conversation.runningBotIds.includes(botId)) return true
    }
    return false
  },

  /* ---- boot -------------------------------------------------------- */

  async bootstrap() {
    return startBootstrap(set, get)
  },

  async refreshBots() {
    const bots = await call(() => bridge().bots.list())
    const record: Record<string, Bot> = {}
    for (const bot of bots) record[bot.id] = bot
    set({ bots: record, botOrder: orderBots(record) })
  },

  async refreshConversations() {
    const list = await call(() => bridge().conversations.list())
    const record: Record<string, ConversationSummary> = {}
    for (const conversation of list) record[conversation.id] = conversation
    set({ conversations: record, conversationOrder: orderConversations(record) })
  },

  /* ---- transcripts ------------------------------------------------- */

  async loadMessages(conversationId) {
    const state = get()
    const existing = state.pagination[conversationId]
    // Already loaded (or loading) — the transcript is kept warm between visits.
    if (existing && !existing.loading && state.messages[conversationId]) return
    if (existing?.loading) return

    set((s) => ({
      pagination: {
        ...s.pagination,
        [conversationId]: { cursor: null, hasMore: false, loading: true }
      }
    }))

    try {
      const page = await call(() =>
        bridge().conversations.getMessages({ conversationId, limit: PAGE_SIZE })
      )
      indexMessages(page.messages)
      set((s) => ({
        messages: { ...s.messages, [conversationId]: page.messages },
        pagination: {
          ...s.pagination,
          [conversationId]: { cursor: page.nextCursor, hasMore: page.hasMore, loading: false }
        }
      }))
    } catch (err) {
      set((s) => ({
        pagination: {
          ...s.pagination,
          [conversationId]: { cursor: null, hasMore: false, loading: false }
        }
      }))
      useUiStore.getState().toast({
        level: 'error',
        title: 'Could not load this conversation',
        body: err instanceof Error ? err.message : undefined
      })
    }
  },

  async loadOlder(conversationId) {
    const state = get()
    const page = state.pagination[conversationId]
    if (!page || page.loading || !page.hasMore || !page.cursor) return

    set((s) => ({
      pagination: { ...s.pagination, [conversationId]: { ...page, loading: true } }
    }))

    try {
      const older = await call(() =>
        bridge().conversations.getMessages({
          conversationId,
          before: page.cursor,
          limit: PAGE_SIZE
        })
      )
      indexMessages(older.messages)
      set((s) => {
        const current = s.messages[conversationId] ?? []
        const seen = new Set(current.map((m) => m.id))
        const prepend = older.messages.filter((m) => !seen.has(m.id))
        return {
          messages: { ...s.messages, [conversationId]: [...prepend, ...current] },
          pagination: {
            ...s.pagination,
            [conversationId]: {
              cursor: older.nextCursor,
              hasMore: older.hasMore,
              loading: false
            }
          }
        }
      })
    } catch {
      set((s) => ({
        pagination: { ...s.pagination, [conversationId]: { ...page, loading: false } }
      }))
    }
  },

  /* ---- sending ----------------------------------------------------- */

  async sendMessage(input) {
    const result = await call(() => bridge().messages.send(input))
    // Main gates an @everyone fan-out rather than silently running N Bots. The
    // store owns the gate so the confirmation appears no matter which surface
    // sent the message.
    if (result.needsEveryoneConfirm) {
      useUiStore.getState().openModal({
        kind: 'everyone',
        input,
        botCount: result.needsEveryoneConfirm.botCount
      })
    }
    return result
  },

  async confirmEveryone(input, remember) {
    return call(() => bridge().messages.confirmEveryone({ ...input, remember }))
  },

  /**
   * The user declined the @everyone fan-out.
   *
   * `sendMessage` persists the user's row BEFORE the gate so their typing is
   * never lost while the dialog is open, so declining has to take that row back
   * out — otherwise it sits in the transcript unanswered and, worse, the
   * instruction the user just declined is replayed into the next Bot's context
   * bridge. Main owns both halves of the cleanup (the row and the pending entry),
   * so this is one call. Toasts on failure and never throws: the dialog must
   * close either way, and trapping the user in it would be the worse bug.
   */
  async cancelEveryone(conversationId) {
    await withToast(() => bridge().messages.cancelPending(conversationId), {
      errorTitle: 'Could not take that message back'
    })
  },

  async retryMessage(messageId) {
    await withToast(() => bridge().messages.retry(messageId), { errorTitle: 'Retry failed' })
  },

  async stopJob(jobId) {
    await withToast(() => bridge().messages.stop(jobId), { errorTitle: 'Could not stop this run' })
  },

  async stopConversation(conversationId) {
    await withToast(() => bridge().messages.stopConversation(conversationId), {
      errorTitle: 'Could not stop this conversation'
    })
  },

  async react(messageId, emoji) {
    await withToast(() => bridge().messages.react(messageId, emoji), {
      errorTitle: 'Could not add that reaction'
    })
  },

  async deleteMessage(messageId) {
    await withToast(() => bridge().messages.remove(messageId), {
      errorTitle: 'Could not delete this message'
    })
  },

  async markRead(conversationId) {
    const conversation = get().conversations[conversationId]
    if (!conversation) return
    // A pure counter optimisation, and only safe because it IS only that: which
    // conversation is on screen goes to main through `conversations.setFocused`
    // (see `subscribeEvents`). While focus rode on this call, skipping it here
    // left main pointing at the previous conversation, so desktop notifications
    // fired for the chat the user was reading.
    if (conversation.unreadCount === 0) return
    // Optimistic: the dot must clear the instant the row is opened.
    set((s) => {
      const current = s.conversations[conversationId]
      if (!current) return s
      return {
        conversations: { ...s.conversations, [conversationId]: { ...current, unreadCount: 0 } }
      }
    })
    try {
      await bridge().conversations.markRead(conversationId)
    } catch {
      // Marking read is ambient. A toast here would be noise, and the next
      // `conversation:updated` re-syncs the count anyway.
    }
  },

  /* ---- bots -------------------------------------------------------- */

  async createBot(input) {
    const bot = await call(() => bridge().bots.create(input))
    upsertBot(set, bot)
    return bot
  },

  async updateBot(id, patch) {
    const bot = await call(() => bridge().bots.update(id, patch))
    upsertBot(set, bot)
    return bot
  },

  async duplicateBot(id) {
    const bot = await call(() => bridge().bots.duplicate(id))
    upsertBot(set, bot)
    return bot
  },

  async setBotPinned(id, pinned) {
    const bot = await call(() => bridge().bots.setPinned(id, pinned))
    upsertBot(set, bot)
  },

  async setBotHidden(id, hidden) {
    const bot = await call(() => bridge().bots.setHidden(id, hidden))
    upsertBot(set, bot)
  },

  async deleteBot(id) {
    await call(() => bridge().bots.remove(id))
    removeBot(set, id)
  },

  /* ---- conversations ----------------------------------------------- */

  async createDirect(botId) {
    const conversation = await call(() => bridge().conversations.createDirect(botId))
    upsertConversation(set, conversation)
    return conversation
  },

  async createGroup(input) {
    const conversation = await call(() => bridge().conversations.createGroup(input))
    upsertConversation(set, conversation)
    return conversation
  },

  async updateConversation(id, patch) {
    const conversation = await call(() => bridge().conversations.update(id, patch))
    upsertConversation(set, conversation)
    return conversation
  },

  async deleteConversation(id) {
    await call(() => bridge().conversations.remove(id))
    removeConversation(set, get, id)
  },

  /* ---- settings and runtime ---------------------------------------- */

  async updateSettings(patch) {
    const settings = await call(() => bridge().settings.update(patch))
    set({ settings })
  },

  async recheckRuntime() {
    const current = get().runtime
    set({
      runtime: current
        ? { ...current, availability: 'checking' }
        : {
            availability: 'checking',
            executablePath: null,
            version: null,
            detail: null,
            checkedAt: new Date().toISOString()
          }
    })
    const runtime = await withToast(() => bridge().runtime.recheck(), {
      errorTitle: 'Could not check Claude Code'
    })
    if (runtime) set({ runtime })
    else if (current) set({ runtime: current })
  }
}))

type Setter = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState> | AppState)
) => void
type Getter = () => AppState

/* ------------------------------------------------------------------ *
 * Shared reducers (used by both actions and events, so an optimistic
 * update and the echoed event converge on the same result)
 * ------------------------------------------------------------------ */

function upsertBot(set: Setter, bot: Bot): void {
  set((s) => {
    const bots = { ...s.bots, [bot.id]: bot }
    return { bots, botOrder: orderBots(bots) }
  })
}

function removeBot(set: Setter, id: string): void {
  set((s) => {
    if (!s.bots[id]) return s
    const bots = { ...s.bots }
    delete bots[id]
    return { bots, botOrder: orderBots(bots) }
  })
}

function upsertConversation(set: Setter, conversation: ConversationSummary): void {
  set((s) => {
    const conversations = { ...s.conversations, [conversation.id]: conversation }
    return { conversations, conversationOrder: orderConversations(conversations) }
  })
}

/**
 * Drop everything keyed off one conversation's messages: the loaded rows, the
 * pagination entry, and the two per-message maps nothing else prunes.
 *
 * Shared by `conversation:deleted` and `conversation:transcriptCleared` so the
 * cleanup cannot drift between them — forgetting `messageConversation` leaks an
 * entry per message for the life of the process AND leaves activity events
 * routing into a conversation whose rows are gone.
 */
function forgetTranscript(
  state: AppState,
  id: string
): Pick<AppState, 'messages' | 'pagination' | 'thinking'> {
  const messages = { ...state.messages }
  const thinking = { ...state.thinking }
  for (const message of messages[id] ?? []) {
    messageConversation.delete(message.id)
    delete thinking[message.id]
  }
  delete messages[id]
  const pagination = { ...state.pagination }
  delete pagination[id]
  return { messages, pagination, thinking }
}

function removeConversation(set: Setter, get: Getter, id: string): void {
  const wasActive = useUiStore.getState().activeConversationId === id
  set((s) => {
    const conversations = { ...s.conversations }
    delete conversations[id]
    return {
      conversations,
      conversationOrder: orderConversations(conversations),
      ...forgetTranscript(s, id)
    }
  })
  if (wasActive) {
    // Never leave the chat column pointed at a conversation that is gone.
    const next = get().conversationOrder.find((cid) => !get().conversations[cid]?.hidden) ?? null
    useUiStore.getState().setActive(next)
  }
}

/* ------------------------------------------------------------------ *
 * bootstrap — idempotent, subscribes to every event exactly once
 * ------------------------------------------------------------------ */

let bootPromise: Promise<void> | null = null
let subscribed = false

function startBootstrap(set: Setter, get: Getter): Promise<void> {
  if (bootPromise) return bootPromise

  bootPromise = (async () => {
    // Subscribe BEFORE the first read: an event that fires while the initial
    // lists are in flight would otherwise be dropped, and a Bot that started a
    // turn during boot would look idle forever.
    subscribeEvents(set, get)

    try {
      const [settings, runtime, bots, conversations] = await Promise.all([
        call(() => bridge().settings.get()),
        call(() => bridge().runtime.status()),
        call(() => bridge().bots.list()),
        call(() => bridge().conversations.list())
      ])

      const botRecord: Record<string, Bot> = {}
      for (const bot of bots) botRecord[bot.id] = bot
      const conversationRecord: Record<string, ConversationSummary> = {}
      for (const conversation of conversations) conversationRecord[conversation.id] = conversation

      set({
        settings,
        runtime,
        bots: botRecord,
        botOrder: orderBots(botRecord),
        conversations: conversationRecord,
        conversationOrder: orderConversations(conversationRecord),
        ready: true,
        bootError: null
      })
    } catch (err) {
      // A failed boot is recoverable: App renders the error with a Retry that
      // clears the cached promise below.
      bootPromise = null
      set({
        ready: true,
        bootError: err instanceof Error ? err.message : 'Could not start Claude Code Bots.'
      })
    }
  })()

  return bootPromise
}

function subscribeEvents(set: Setter, get: Getter): void {
  if (subscribed) return
  subscribed = true

  const events = bridge().events
  const ui = () => useUiStore.getState()

  /* ---- which conversation is on screen ------------------------------ */

  /**
   * Report the open conversation to main on every change, including to null.
   *
   * This used to ride on `conversations.markRead`, which returns early whenever
   * the store already believes the unread count is 0 — so opening a conversation
   * you had already read never told main anything. Main kept suppressing (and
   * notifying) for whichever conversation was last marked read, which meant a
   * desktop banner for the chat filling the screen after nothing more exotic than
   * switching between two chats. `markRead` also can never say "nothing is open",
   * so after deleting a conversation main went on suppressing for a chat that no
   * longer existed and ⌘. (Stop) kept targeting it.
   */
  let reportedFocus: string | null | undefined
  const reportFocus = (id: string | null): void => {
    if (id === reportedFocus) return
    reportedFocus = id
    void bridge()
      .conversations.setFocused(id)
      .catch(() => {
        // Ambient. Clear the memo so the next change retries rather than
        // believing main already knows.
        reportedFocus = undefined
      })
  }
  reportFocus(ui().activeConversationId)
  useUiStore.subscribe((state) => reportFocus(state.activeConversationId))

  /* ---- messages ---------------------------------------------------- */

  events.on('message:created', ({ message }) => {
    messageConversation.set(message.id, message.conversationId)
    set((s) => {
      const list = s.messages[message.conversationId]
      // Not loaded yet: `loadMessages` will fetch this message with the rest.
      if (!list) return s
      if (list.some((m) => m.id === message.id)) return s
      return {
        messages: { ...s.messages, [message.conversationId]: insertMessage(list, message) }
      }
    })
  })

  events.on('message:delta', (payload) => {
    if (payload.textDelta) {
      set((s) => {
        const list = s.messages[payload.conversationId]
        if (!list) return s
        const i = list.findIndex((m) => m.id === payload.messageId)
        if (i === -1) return s
        const next = list.slice()
        next[i] = {
          ...list[i]!,
          bodyMarkdown: list[i]!.bodyMarkdown + (payload.textDelta ?? '')
        }
        return { messages: { ...s.messages, [payload.conversationId]: next } }
      })
    }
    if (payload.thinkingDelta) {
      // Thinking is kept in its own map: appending it to `bodyMarkdown` would
      // corrupt the transcript and get persisted on the next update event.
      set((s) => ({
        thinking: {
          ...s.thinking,
          [payload.messageId]: (s.thinking[payload.messageId] ?? '') + payload.thinkingDelta
        }
      }))
    }
  })

  events.on('message:updated', ({ message }) => {
    messageConversation.set(message.id, message.conversationId)
    set((s) => {
      const list = s.messages[message.conversationId]
      if (!list) return s
      const i = list.findIndex((m) => m.id === message.id)
      if (i === -1) {
        return {
          messages: { ...s.messages, [message.conversationId]: insertMessage(list, message) }
        }
      }
      const next = list.slice()
      next[i] = message
      // `createdAt` is the sort key, and one update really does move a row:
      // session recovery re-stamps its reply so the "started a fresh session"
      // notice sorts above the answer it explains (JobScheduler, PRD §37).
      // Replacing in place left the row where it was until a reload, so re-seat
      // it when it no longer belongs between its neighbours.
      const before = next[i - 1]
      const after = next[i + 1]
      const misplaced =
        (before !== undefined && message.createdAt < before.createdAt) ||
        (after !== undefined && message.createdAt > after.createdAt)
      if (misplaced) {
        next.splice(i, 1)
        return {
          messages: { ...s.messages, [message.conversationId]: insertMessage(next, message) }
        }
      }
      return { messages: { ...s.messages, [message.conversationId]: next } }
    })
  })

  events.on('message:deleted', ({ messageId, conversationId }) => {
    messageConversation.delete(messageId)
    set((s) => {
      const list = s.messages[conversationId]
      if (!list) return s
      const next = list.filter((m) => m.id !== messageId)
      // The live thinking buffer is keyed by message id and nothing else prunes
      // it; without this it grows for the lifetime of the process.
      const thinking = s.thinking[messageId] === undefined ? s.thinking : omitKey(s.thinking, messageId)
      if (next.length === list.length && thinking === s.thinking) return s
      return { messages: { ...s.messages, [conversationId]: next }, thinking }
    })
  })

  /* ---- activities -------------------------------------------------- */

  const applyActivity = (activity: Activity): void => {
    const conversationId = messageConversation.get(activity.messageId)
    if (!conversationId) return
    set((s) => {
      const patch = replaceMessage(s, conversationId, activity.messageId, (message) =>
        upsertActivity(message, activity)
      )
      return patch ?? s
    })
  }

  events.on('activity:created', ({ activity }) => applyActivity(activity))
  events.on('activity:updated', ({ activity }) => applyActivity(activity))

  /* ---- jobs -------------------------------------------------------- */

  events.on('job:updated', ({ job }) => {
    set((s) => {
      const jobs = { ...s.jobs, [job.id]: job }
      const conversation = s.conversations[job.conversationId]
      if (!conversation) return { jobs }

      // Recompute this conversation's live Bot sets from the jobs we know about.
      // Main also sends `conversation:updated` when a turn finishes, but that
      // lands after the final message; recomputing here keeps the sidebar's
      // working ring in step with the run itself.
      const running: string[] = []
      const queued: string[] = []
      for (const candidate of Object.values(jobs)) {
        if (candidate.conversationId !== job.conversationId) continue
        if (candidate.status === 'running' && !running.includes(candidate.botId)) {
          running.push(candidate.botId)
        } else if (candidate.status === 'queued' && !queued.includes(candidate.botId)) {
          queued.push(candidate.botId)
        }
      }

      return {
        jobs,
        conversations: {
          ...s.conversations,
          [job.conversationId]: {
            ...conversation,
            runningBotIds: running,
            queuedBotIds: queued.filter((id) => !running.includes(id))
          }
        }
      }
    })
  })

  /* ---- conversations ----------------------------------------------- */

  events.on('conversation:created', ({ conversation }) => upsertConversation(set, conversation))
  events.on('conversation:updated', ({ conversation }) => {
    set((s) => {
      const previous = s.conversations[conversation.id]
      // The open conversation is being read right now, so a fresh unread count
      // from main would put a dot on the row the user is looking at.
      const active = useUiStore.getState().activeConversationId === conversation.id
      const merged: ConversationSummary =
        active && document.hasFocus() ? { ...conversation, unreadCount: 0 } : conversation
      if (previous === merged) return s
      const conversations = { ...s.conversations, [conversation.id]: merged }
      return { conversations, conversationOrder: orderConversations(conversations) }
    })
  })
  events.on('conversation:deleted', ({ conversationId }) => {
    removeConversation(set, get, conversationId)
  })
  events.on('conversation:transcriptCleared', ({ conversationId }) => {
    // Nothing to do for a conversation this window has never opened; it will
    // fetch the (now empty) transcript when it is first visited.
    const state = get()
    if (!state.messages[conversationId] && !state.pagination[conversationId]) return
    // The conversation itself survives, so only its transcript is dropped. The
    // pagination entry has to go with it: `loadMessages` short-circuits on a warm
    // cache, so leaving it would mean the refetch below did nothing and the
    // deleted rows stayed on screen until the next launch — which is exactly the
    // bug this event exists to close.
    set((s) => forgetTranscript(s, conversationId))
    void get().loadMessages(conversationId)
  })

  /* ---- bots -------------------------------------------------------- */

  events.on('bot:created', ({ bot }) => upsertBot(set, bot))
  events.on('bot:updated', ({ bot }) => upsertBot(set, bot))
  events.on('bot:deleted', ({ botId }) => removeBot(set, botId))

  /* ---- runtime and settings ---------------------------------------- */

  events.on('runtime:status', (runtime) => set({ runtime }))

  events.on('runtime:rateLimit', (info) => {
    // Claude Code emits a rate_limit_event at the START OF EVERY TURN, almost
    // always with status "allowed". Toasting on all of them would warn the user
    // that they are out of allowance on every single message they send. Only a
    // non-allowed status means the turn is actually being blocked.
    const status = (info.status ?? '').toLowerCase().trim()
    const blocking = status.length > 0 && !status.startsWith('allowed') && status !== 'ok'
    if (!blocking) return

    // One warning per reset window: the same limit is re-reported on every
    // queued turn behind it, and five identical toasts is not five times as
    // useful as one.
    const key = `${status}:${info.resetsAt ?? 'none'}`
    if (key === lastRateLimitKey) return
    lastRateLimitKey = key

    // PRD §37 copy, verbatim. Never mention API keys or billing.
    ui().toast({
      level: 'warn',
      title: 'Claude Code usage limit reached',
      body:
        info.resetsAt !== null
          ? `Your Bot history is safe. Retry after your Claude allowance resets at ${new Date(
              info.resetsAt * 1000
            ).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`
          : 'Your Bot history is safe. Retry after your Claude allowance resets.'
    })
  })

  events.on('settings:updated', ({ settings }) => set({ settings }))

  /* ---- app-level notices and navigation ---------------------------- */

  events.on('app:notice', (notice) => {
    ui().toast({
      level: notice.level,
      title: notice.title,
      body: notice.body,
      actionLabel: notice.conversationId ? 'Open' : undefined,
      onAction: notice.conversationId
        ? () => {
            const id = notice.conversationId
            if (id) {
              useUiStore.getState().setActive(id)
              void get().markRead(id)
            }
          }
        : undefined
    })
  })

  events.on('app:navigate', ({ conversationId, messageId }) => {
    const state = useUiStore.getState()
    state.setActive(conversationId)
    if (messageId) state.jumpTo(messageId)
    void get().loadMessages(conversationId)
    void get().markRead(conversationId)
  })

  events.on('app:command', ({ command }) => {
    const state = useUiStore.getState()
    switch (command) {
      case 'new-bot':
        state.openModal({ kind: 'bot' })
        break
      case 'new-group':
        state.openModal({ kind: 'group' })
        break
      case 'search':
        state.setPalette('search')
        break
      case 'command-palette':
        state.setPalette('command')
        break
      case 'settings':
        state.openModal({ kind: 'settings', tab: 'general' })
        break
      case 'toggle-details':
        state.toggleDetails()
        break
      case 'toggle-sidebar':
        state.toggleSidebar()
        break
      case 'shortcuts':
        state.openModal({ kind: 'shortcuts' })
        break
    }
  })
}

/** Clears the cached boot promise so a failed boot can be retried. */
export function resetBootstrap(): void {
  bootPromise = null
}

/** Non-reactive read for callbacks and event handlers. */
export function appState(): AppState {
  return useAppStore.getState()
}
