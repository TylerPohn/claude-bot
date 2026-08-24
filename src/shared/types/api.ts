/**
 * The typed surface exposed on `window.botApp` by the preload bridge.
 * Main registers one ipcMain.handle per channel in IPC_CHANNELS.
 */
import type {
  AppSettings,
  Attachment,
  Bot,
  BotJob,
  Conversation,
  ConversationSummary,
  DiagnosticsReport,
  Message,
  RuntimeStatus,
  SearchResult
} from './index'
import type { AppEventMap, AppEventName } from './events'
import type {
  BotDraftInput,
  BotPatchInput,
  ConversationPatchInput,
  CreateGroupInput,
  GetMessagesInput,
  SearchInput,
  SendMessageInput,
  SettingsPatchInput
} from '../schemas'

export interface MessagePage {
  messages: Message[]
  /** ISO cursor to pass as `before` for the previous page; null when at the start. */
  nextCursor: string | null
  hasMore: boolean
}

export interface SendMessageResult {
  message: Message
  jobs: BotJob[]
  /** Set when the send was rejected pending user confirmation. */
  needsEveryoneConfirm?: {
    conversationId: string
    botCount: number
    /**
     * The user's message is persisted before the dialog opens so their typing is
     * never lost. Declining must therefore take it back out — either through
     * `messages.cancelPending`, or by removing this id — otherwise the Bots read
     * the declined instruction from the context bridge on their next turn.
     */
    pendingMessageId: string
  }
}

/**
 * One Bot's persisted Claude Code session row for a conversation, as the details
 * drawer reads it.
 *
 * Exists because the drawer used to derive session ids from the jobs THIS window
 * had seen, so after a restart it told the user every Bot had no session — the
 * exact opposite of the truth, in the one panel whose job is to answer "did my
 * team keep its context?". The ids live in `bot_conversation_sessions` and main
 * resumes straight from there, so the renderer reads the same rows.
 */
export interface ConversationSessionInfo {
  botId: string
  claudeSessionId: string | null
  /** When the row was last written; null when there is no row at all. */
  updatedAt: string | null
}

export interface PickDirectoryResult {
  path: string | null
}

export interface PickFilesResult {
  files: Array<{ path: string; name: string; sizeBytes: number | null; kind: 'file' | 'folder' | 'image'; mimeType: string | null }>
}

export interface BotApi {
  bots: {
    list(): Promise<Bot[]>
    get(id: string): Promise<Bot | null>
    create(input: BotDraftInput): Promise<Bot>
    update(id: string, patch: BotPatchInput): Promise<Bot>
    duplicate(id: string): Promise<Bot>
    setPinned(id: string, pinned: boolean): Promise<Bot>
    setHidden(id: string, hidden: boolean): Promise<Bot>
    remove(id: string): Promise<void>
    /** Preset templates offered during onboarding and the new-bot sheet. */
    presets(): Promise<Array<BotDraftInput & { presetId: string; tagline: string }>>
  }

  conversations: {
    list(): Promise<ConversationSummary[]>
    get(id: string): Promise<ConversationSummary | null>
    createDirect(botId: string): Promise<ConversationSummary>
    createGroup(input: CreateGroupInput): Promise<ConversationSummary>
    update(id: string, patch: ConversationPatchInput): Promise<ConversationSummary>
    remove(id: string): Promise<void>
    markRead(id: string): Promise<void>
    /**
     * Tells main which conversation is on screen, or null when none is.
     *
     * Deliberately separate from `markRead`, which the renderer skips whenever it
     * already believes the unread count is 0: focus reporting must not depend on
     * there having been something unread. NotificationService uses this to
     * suppress alerts for the conversation the user is looking at (PRD §33), and
     * the app menu uses it for ⌘. (Stop) and Export transcript.
     */
    setFocused(id: string | null): Promise<void>
    getMessages(input: GetMessagesInput): Promise<MessagePage>
    search(input: SearchInput): Promise<SearchResult[]>
    exportMarkdown(id: string): Promise<{ path: string | null }>
    clearTranscript(id: string): Promise<void>
    /**
     * The persisted Claude session row for every member, in membership order.
     * Read-only, and batched rather than per-Bot so opening the details drawer
     * on a large group is one call.
     */
    sessions(id: string): Promise<ConversationSessionInfo[]>
  }

  messages: {
    send(input: SendMessageInput): Promise<SendMessageResult>
    /** Confirms an @everyone fan-out that was gated by the confirm dialog. */
    confirmEveryone(input: SendMessageInput & { remember: boolean }): Promise<SendMessageResult>
    /**
     * Discards a send that is waiting on the @everyone confirmation: removes the
     * message that was persisted ahead of the dialog and forgets the pending
     * state, in one call. Safe to call when nothing is pending.
     *
     * REQUIRED. It was typed optional while the preload had not exposed it, and
     * the dialog's Cancel therefore just closed: the user's message stayed in the
     * transcript and the instruction they had declined was replayed into the next
     * Bot's context bridge. Every dismiss path (Cancel, Esc, scrim) must call this.
     */
    cancelPending(conversationId: string): Promise<{ messageId: string | null }>
    retry(messageId: string): Promise<SendMessageResult>
    stop(jobId: string): Promise<void>
    stopConversation(conversationId: string): Promise<void>
    react(messageId: string, emoji: string): Promise<Message>
    remove(messageId: string): Promise<void>
  }

  runtime: {
    status(): Promise<RuntimeStatus>
    recheck(): Promise<RuntimeStatus>
    openLoginTerminal(): Promise<void>
    pickExecutable(): Promise<{ path: string | null }>
  }

  settings: {
    get(): Promise<AppSettings>
    update(patch: SettingsPatchInput): Promise<AppSettings>
  }

  system: {
    pickDirectory(defaultPath?: string): Promise<PickDirectoryResult>
    pickFiles(): Promise<PickFilesResult>
    revealPath(path: string): Promise<void>
    openPath(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    openTerminalAt(path: string): Promise<void>
    openEditorAt(path: string): Promise<void>
    pathExists(path: string): Promise<boolean>
    copyText(text: string): Promise<void>
    /** Native context menu; resolves with the chosen item id or null. */
    contextMenu(items: ContextMenuItem[]): Promise<string | null>
    diagnostics(): Promise<DiagnosticsReport>
    exportBackup(): Promise<{ path: string | null }>
    importBackup(): Promise<{ imported: boolean; error?: string }>
    revealAppData(): Promise<void>
    clearAllData(): Promise<void>
    appInfo(): Promise<{ version: string; platform: string; isMac: boolean }>
  }

  events: {
    /** Subscribe to a single event name. Returns an unsubscribe function. */
    on<K extends AppEventName>(name: K, handler: (payload: AppEventMap[K]) => void): () => void
  }
}

export interface ContextMenuItem {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  danger?: boolean
  submenu?: ContextMenuItem[]
}

export const IPC_CHANNELS = {
  botsList: 'bots:list',
  botsGet: 'bots:get',
  botsCreate: 'bots:create',
  botsUpdate: 'bots:update',
  botsDuplicate: 'bots:duplicate',
  botsSetPinned: 'bots:setPinned',
  botsSetHidden: 'bots:setHidden',
  botsRemove: 'bots:remove',
  botsPresets: 'bots:presets',

  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreateDirect: 'conversations:createDirect',
  conversationsCreateGroup: 'conversations:createGroup',
  conversationsUpdate: 'conversations:update',
  conversationsRemove: 'conversations:remove',
  conversationsMarkRead: 'conversations:markRead',
  conversationsSetFocused: 'conversations:setFocused',
  conversationsGetMessages: 'conversations:getMessages',
  conversationsSearch: 'conversations:search',
  conversationsExportMarkdown: 'conversations:exportMarkdown',
  conversationsClearTranscript: 'conversations:clearTranscript',
  conversationsSessions: 'conversations:sessions',

  messagesSend: 'messages:send',
  messagesConfirmEveryone: 'messages:confirmEveryone',
  messagesCancelPending: 'messages:cancelPending',
  messagesRetry: 'messages:retry',
  messagesStop: 'messages:stop',
  messagesStopConversation: 'messages:stopConversation',
  messagesReact: 'messages:react',
  messagesRemove: 'messages:remove',

  runtimeStatus: 'runtime:status',
  runtimeRecheck: 'runtime:recheck',
  runtimeOpenLoginTerminal: 'runtime:openLoginTerminal',
  runtimePickExecutable: 'runtime:pickExecutable',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  systemPickDirectory: 'system:pickDirectory',
  systemPickFiles: 'system:pickFiles',
  systemRevealPath: 'system:revealPath',
  systemOpenPath: 'system:openPath',
  systemOpenExternal: 'system:openExternal',
  systemOpenTerminalAt: 'system:openTerminalAt',
  systemOpenEditorAt: 'system:openEditorAt',
  systemPathExists: 'system:pathExists',
  systemCopyText: 'system:copyText',
  systemContextMenu: 'system:contextMenu',
  systemDiagnostics: 'system:diagnostics',
  systemExportBackup: 'system:exportBackup',
  systemImportBackup: 'system:importBackup',
  systemRevealAppData: 'system:revealAppData',
  systemClearAllData: 'system:clearAllData',
  systemAppInfo: 'system:appInfo'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** Single push channel; payload is a discriminated AppEvent. */
export const APP_EVENT_CHANNEL = 'app:event'

export type { Attachment, Conversation }
