/**
 * Domain types shared between the Electron main process, the preload bridge and
 * the renderer. This file must stay dependency-free (no node, no electron, no
 * react imports) so that every layer can import it.
 */

/* ------------------------------------------------------------------ *
 * Bots
 * ------------------------------------------------------------------ */

/**
 * `shape` is the default and the product's signature look: a flat solid-color
 * abstract blob with two white eye slits, rendered as inline SVG. `avatarValue`
 * then holds a BotShape and `accent` holds the fill color.
 */
export type AvatarType = 'shape' | 'emoji' | 'initials' | 'image'

export const BOT_SHAPES = [
  'circle',
  'squircle',
  'teardrop',
  'egg',
  'hexagon',
  'capsule',
  'arch',
  'clover',
  'triangle',
  'flag'
] as const

export type BotShape = (typeof BOT_SHAPES)[number]

/**
 * Permission modes the UI can set.
 *
 * `bypassPermissions` — shown as "YOLO" everywhere a human reads it — turns every
 * permission check off for that Bot's turns. It is a real Claude Code mode and
 * reaches the CLI as `--permission-mode bypassPermissions`, the flag form of
 * `--dangerously-skip-permissions`; the runtime needs no special case for it
 * (`buildClaudeArgs` forwards any mode that is not `default`). Every surface that
 * renders a mode name treats it as its own tone, not a fourth ordinary choice.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** Model preference. `default` means "don't pass --model, use the user's Claude Code default". */
export type ModelPreference = 'default' | 'opus' | 'sonnet' | 'haiku' | (string & {})

export interface Bot {
  id: string
  name: string
  title: string | null
  description: string
  avatarType: AvatarType
  avatarValue: string
  /** Tailwind-independent accent token key, e.g. "violet". Drives avatar + mention chip color. */
  accent: BotAccent
  defaultWorkingDirectory: string | null
  model: ModelPreference
  permissionMode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
  pinned: boolean
  hidden: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export const BOT_ACCENTS = [
  'violet',
  'blue',
  'cyan',
  'emerald',
  'amber',
  'orange',
  'rose',
  'pink',
  'lime',
  'indigo'
] as const

export type BotAccent = (typeof BOT_ACCENTS)[number]

export interface BotDraft {
  name: string
  title?: string | null
  description: string
  avatarType?: AvatarType
  avatarValue?: string
  accent?: BotAccent
  defaultWorkingDirectory?: string | null
  model?: ModelPreference
  permissionMode?: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
}

export type BotPatch = Partial<BotDraft & { pinned: boolean; hidden: boolean }>

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

export type ConversationType = 'direct' | 'group'

export interface Conversation {
  id: string
  type: ConversationType
  name: string
  /** Optional emoji shown for groups. Direct chats use the bot's avatar. */
  icon: string | null
  memberBotIds: string[]
  workspaceDirectory: string | null
  defaultResponderBotId: string | null
  /** When true, @everyone in this group skips the "run N bots?" confirmation. */
  skipEveryoneConfirm: boolean
  pinned: boolean
  hidden: boolean
  createdAt: string
  updatedAt: string
}

export interface ConversationSummary extends Conversation {
  lastMessageAt: string | null
  lastMessagePreview: string | null
  lastMessageAuthorName: string | null
  unreadCount: number
  runningBotIds: string[]
  queuedBotIds: string[]
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export type AuthorType = 'user' | 'bot' | 'system'

export type MessageStatus =
  | 'complete'
  | 'streaming'
  | 'queued'
  | 'running'
  | 'error'
  | 'cancelled'
  | 'interrupted'

/** Kinds of system message we render as inset cards rather than chat bubbles. */
export type SystemMessageKind =
  | 'generic'
  | 'handoff'
  | 'session_recovered'
  | 'rate_limit'
  | 'permission_denied'
  | 'loop_guard'
  | 'workspace_missing'
  | 'bot_removed'
  | 'interrupted'

export interface MessageMention {
  botId: string | null
  display: string
  /** true when the mention was `@everyone` rather than a specific bot. */
  everyone: boolean
  startIndex: number
  endIndex: number
}

export interface Attachment {
  id: string
  messageId: string
  path: string
  name: string
  kind: 'file' | 'folder' | 'image'
  sizeBytes: number | null
  mimeType: string | null
  missing: boolean
  createdAt: string
}

export interface Message {
  id: string
  conversationId: string
  authorType: AuthorType
  authorBotId: string | null
  /** Denormalized so historical messages survive a bot rename or delete. */
  authorName: string | null
  authorAvatarType: AvatarType | null
  authorAvatarValue: string | null
  authorAccent: BotAccent | null
  bodyMarkdown: string
  /** Extended thinking, when the model emitted any and the user has it enabled.
   *  Persisted so it survives a restart rather than living only in the live
   *  delta stream. */
  thinkingMarkdown: string
  replyToMessageId: string | null
  status: MessageStatus
  systemKind: SystemMessageKind | null
  /** Set on bot messages produced by a handoff, so the UI can show the chain. */
  handoffFromBotId: string | null
  jobId: string | null
  errorText: string | null
  mentions: MessageMention[]
  attachments: Attachment[]
  activities: Activity[]
  reactions: Reaction[]
  usage: MessageUsage | null
  createdAt: string
  updatedAt: string
}

export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number | null
  durationMs: number | null
  numTurns: number | null
  model: string | null
}

export interface Reaction {
  emoji: string
  count: number
  mine: boolean
}

/* ------------------------------------------------------------------ *
 * Activities (normalized Claude Code tool events)
 * ------------------------------------------------------------------ */

export type ActivityType =
  | 'thinking'
  | 'tool'
  | 'command'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'search'
  | 'web'
  | 'task'
  | 'todo'
  | 'mcp'
  | 'notebook'
  | 'error'

/**
 * `cancelled` means the tool never reported back: the turn was stopped, failed,
 * or died with the app while the call was in flight. Distinct from `error`,
 * which is a tool that ran and returned a failure — the transcript says
 * "stopped", not "failed", and it is not counted in the failure total.
 */
export type ActivityStatus = 'running' | 'success' | 'error' | 'cancelled'

export interface Activity {
  id: string
  messageId: string
  botId: string | null
  type: ActivityType
  /** Short one-line label, e.g. "Ran `npm test`" or "Edited src/app.ts". */
  title: string
  /** Secondary line, e.g. the file path or the command's first output line. */
  subtitle: string | null
  /** Full raw input/output for the expanded view. */
  detail: string | null
  toolName: string | null
  toolUseId: string | null
  status: ActivityStatus
  /** Line counts for edit activities, when derivable. */
  addedLines: number | null
  removedLines: number | null
  startedAt: string
  endedAt: string | null
  /** Ordering within a message. */
  seq: number
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled' | 'interrupted'

export interface BotJob {
  id: string
  botId: string
  conversationId: string
  triggeringMessageId: string | null
  /** The assistant message this job is writing into. */
  responseMessageId: string
  status: JobStatus
  handoffDepth: number
  /** Root human message that ultimately caused this job — used for turn budgets. */
  originMessageId: string | null
  processPid: number | null
  claudeSessionId: string | null
  errorText: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export interface BotConversationSession {
  botId: string
  conversationId: string
  claudeSessionId: string | null
  lastSeenMessageId: string | null
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export type Appearance = 'system' | 'light' | 'dark'

export interface AppSettings {
  appearance: Appearance
  launchAtLogin: boolean
  showNotifications: boolean
  notifyOnFocusedConversation: boolean
  defaultWorkspace: string | null
  maxConcurrentBots: number
  allowSameBotConcurrentConversations: boolean
  claudeExecutablePath: string | null
  defaultModel: ModelPreference
  defaultPermissionMode: PermissionMode
  globalAllowedTools: string[]
  globalDisallowedTools: string[]
  /** Extra `--disallowedTools` entries applied unless the user opts out. */
  safetyGuardrails: boolean
  handoffsEnabled: boolean
  maxHandoffDepth: number
  maxAutomatedTurnsPerHumanMessage: number
  groupBridgeCharBudget: number
  showThinking: boolean
  sendKey: 'enter' | 'mod+enter'
  onboardingCompleted: boolean
  fontScale: number
}

/* ------------------------------------------------------------------ *
 * Runtime status
 * ------------------------------------------------------------------ */

export type RuntimeAvailability = 'ok' | 'missing' | 'unauthenticated' | 'error' | 'checking'

export interface RuntimeStatus {
  availability: RuntimeAvailability
  executablePath: string | null
  version: string | null
  /** Raw text from `claude doctor` / version probe, for diagnostics. */
  detail: string | null
  checkedAt: string
}

export interface RateLimitInfo {
  status: string
  resetsAt: number | null
  rateLimitType: string | null
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export interface SearchResult {
  messageId: string
  conversationId: string
  conversationName: string
  conversationType: ConversationType
  authorName: string | null
  authorType: AuthorType
  authorAccent: BotAccent | null
  snippetHtmlSafe: string
  createdAt: string
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

export interface DiagnosticsReport {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  arch: string
  claudeVersion: string | null
  claudeExecutablePath: string | null
  dbPath: string
  parseErrors: number
  recentExitCodes: Array<{ jobId: string; code: number | null; signal: string | null; at: string }>
  settings: AppSettings
}
