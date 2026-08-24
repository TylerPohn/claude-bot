/**
 * Events pushed from the main process to the renderer over IPC.
 * The renderer subscribes once and reduces these into its Zustand store.
 */
import type {
  Activity,
  BotJob,
  Conversation,
  ConversationSummary,
  Message,
  RateLimitInfo,
  RuntimeStatus,
  AppSettings,
  Bot
} from './index'

export interface AppEventMap {
  /** A brand new message row appeared (user, bot placeholder, or system). */
  'message:created': { message: Message }
  /** Incremental assistant text for a streaming message. */
  'message:delta': {
    messageId: string
    conversationId: string
    /** Text appended to bodyMarkdown. */
    textDelta?: string
    /** Text appended to the thinking buffer. */
    thinkingDelta?: string
  }
  /** Message metadata changed (status, usage, error, final body). */
  'message:updated': { message: Message }
  'message:deleted': { messageId: string; conversationId: string }

  'activity:created': { activity: Activity }
  'activity:updated': { activity: Activity }

  'job:updated': { job: BotJob }

  'conversation:updated': { conversation: ConversationSummary }
  'conversation:created': { conversation: ConversationSummary }
  'conversation:deleted': { conversationId: string }
  /**
   * Every message row in this conversation was deleted, but the conversation
   * itself survives (the details drawer's Clear transcript, and `/clear`).
   *
   * Its own event rather than a flag on `conversation:updated`, because the
   * reducer for that one only ever touches the conversation list: main used to
   * delete the whole transcript and say nothing the renderer could act on, so
   * the success toast fired while all the rows stayed on screen — interactive,
   * and backed by nothing — until the next app launch.
   */
  'conversation:transcriptCleared': { conversationId: string }

  'bot:updated': { bot: Bot }
  'bot:created': { bot: Bot }
  'bot:deleted': { botId: string }

  'runtime:status': RuntimeStatus
  'runtime:rateLimit': RateLimitInfo

  'settings:updated': { settings: AppSettings }

  /** Toast-level notice surfaced in the renderer. */
  'app:notice': {
    id: string
    level: 'info' | 'warn' | 'error' | 'success'
    title: string
    body?: string
    conversationId?: string
  }

  /** Main asks the renderer to focus a conversation (from a notification click). */
  'app:navigate': { conversationId: string; messageId?: string }

  /** Main asks the renderer to open a UI surface (from the app menu). */
  'app:command': {
    command:
      | 'new-bot'
      | 'new-group'
      | 'search'
      | 'settings'
      | 'command-palette'
      | 'toggle-details'
      | 'toggle-sidebar'
      | 'shortcuts'
  }
}

export type AppEventName = keyof AppEventMap

export type AppEvent = {
  [K in AppEventName]: { type: K; payload: AppEventMap[K] }
}[AppEventName]

/** Emitted by the Claude runtime adapter; normalized from Claude Code stream-json. */
export type RuntimeEvent =
  | { type: 'session'; sessionId: string; model: string | null; permissionMode: string | null; cwd: string | null; mcpServers: Array<{ name: string; status: string }>; claudeCodeVersion: string | null }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_block'; text: string }
  | { type: 'tool_start'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_end'; toolUseId: string; isError: boolean; content: string; structured: unknown }
  | { type: 'rate_limit'; info: RateLimitInfo }
  | { type: 'status'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'parse_error'; raw: string; error: string }
  | {
      type: 'result'
      isError: boolean
      subtype: string
      resultText: string | null
      sessionId: string | null
      usage: {
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens: number
        cacheCreationInputTokens: number
      } | null
      costUsd: number | null
      durationMs: number | null
      numTurns: number | null
      model: string | null
      permissionDenials: unknown[]
    }
  | { type: 'exit'; code: number | null; signal: string | null }

export interface Conversationish extends Conversation {}
