/**
 * Row shapes and row -> domain mapping.
 *
 * SQLite hands back snake_case columns with loose types (integers for booleans,
 * TEXT for every enum and every JSON blob). This module is the single place that
 * translates: repositories never inspect a raw column, and nothing outside this
 * file may assume a column name. Every enum coming out of the database is
 * re-validated against the domain union rather than cast, so a hand-edited or
 * partially-migrated database degrades to a sane default instead of poisoning
 * the renderer with a value it has no branch for.
 */
import type {
  Activity,
  ActivityStatus,
  ActivityType,
  Attachment,
  AuthorType,
  AvatarType,
  Bot,
  BotAccent,
  BotConversationSession,
  BotJob,
  Conversation,
  ConversationType,
  JobStatus,
  Message,
  MessageMention,
  MessageStatus,
  MessageUsage,
  ModelPreference,
  PermissionMode,
  Reaction,
  SystemMessageKind
} from '@shared/types'
import { BOT_ACCENTS } from '@shared/types'

/* ------------------------------------------------------------------ *
 * Row shapes (exactly the columns declared in migration 1)
 * ------------------------------------------------------------------ */

export interface BotRow {
  id: string
  name: string
  title: string | null
  description: string
  avatar_type: string
  avatar_value: string
  accent: string
  default_working_directory: string | null
  model: string
  permission_mode: string
  allowed_tools: string
  disallowed_tools: string
  pinned: number
  hidden: number
  archived_at: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ConversationRow {
  id: string
  type: string
  name: string
  icon: string | null
  workspace_directory: string | null
  default_responder_bot_id: string | null
  skip_everyone_confirm: number
  pinned: number
  hidden: number
  last_read_at: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  conversation_id: string
  author_type: string
  author_bot_id: string | null
  author_name: string | null
  author_avatar_type: string | null
  author_avatar_value: string | null
  author_accent: string | null
  body_markdown: string
  thinking_markdown: string
  reply_to_message_id: string | null
  status: string
  system_kind: string | null
  handoff_from_bot_id: string | null
  job_id: string | null
  error_text: string | null
  usage_json: string | null
  seq: number
  created_at: string
  updated_at: string
}

export interface MentionRow {
  id: number
  message_id: string
  bot_id: string | null
  display: string
  everyone: number
  start_index: number
  end_index: number
}

export interface AttachmentRow {
  id: string
  message_id: string
  path: string
  name: string
  kind: string
  size_bytes: number | null
  mime_type: string | null
  missing: number
  created_at: string
}

export interface ActivityRow {
  id: string
  message_id: string
  bot_id: string | null
  type: string
  title: string
  subtitle: string | null
  detail: string | null
  tool_name: string | null
  tool_use_id: string | null
  status: string
  added_lines: number | null
  removed_lines: number | null
  started_at: string
  ended_at: string | null
  seq: number
}

export interface JobRow {
  id: string
  bot_id: string
  conversation_id: string
  triggering_message_id: string | null
  response_message_id: string
  origin_message_id: string | null
  status: string
  handoff_depth: number
  process_pid: number | null
  claude_session_id: string | null
  error_text: string | null
  exit_code: number | null
  exit_signal: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface SessionRow {
  bot_id: string
  conversation_id: string
  claude_session_id: string | null
  last_seen_message_id: string | null
  created_at: string
  updated_at: string
}

export interface ReactionRow {
  message_id: string
  emoji: string
  created_at: string
}

/**
 * `Message` plus the persisted thinking buffer.
 *
 * The `messages` table keeps `thinking_markdown` in its own column so streaming
 * reasoning never has to be spliced in and out of the body, but the shared
 * `Message` type (owned by another module and not editable here) does not declare
 * it. Returning this structurally-wider record keeps the data reachable for the
 * "Show thinking" setting while remaining assignable to `Message` everywhere.
 */
export interface MessageRecord extends Message {
  thinkingMarkdown: string
}

/* ------------------------------------------------------------------ *
 * Primitive coercion
 * ------------------------------------------------------------------ */

/**
 * SQLite has no boolean type: everything is stored as 0/1 INTEGER. The `boolean`
 * arm exists because a value can also arrive from a JSON blob rather than a column.
 */
export function toBool(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true
}

export function fromBool(value: boolean | null | undefined): number {
  return value ? 1 : 0
}

/**
 * better-sqlite3 rejects `undefined` and booleans as bind parameters. Every
 * dynamically-built statement funnels its values through here.
 */
export function bindValue(value: unknown): string | number | bigint | Buffer | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (Buffer.isBuffer(value)) return value
  // Anything else (arrays of tool patterns, usage objects) is stored as JSON text.
  return JSON.stringify(value)
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const AVATAR_TYPES: readonly AvatarType[] = ['shape', 'emoji', 'initials', 'image']
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']
const CONVERSATION_TYPES: readonly ConversationType[] = ['direct', 'group']
const AUTHOR_TYPES: readonly AuthorType[] = ['user', 'bot', 'system']
const MESSAGE_STATUSES: readonly MessageStatus[] = [
  'complete',
  'streaming',
  'queued',
  'running',
  'error',
  'cancelled',
  'interrupted'
]
const SYSTEM_KINDS: readonly SystemMessageKind[] = [
  'generic',
  'handoff',
  'session_recovered',
  'rate_limit',
  'permission_denied',
  'loop_guard',
  'workspace_missing',
  'bot_removed',
  'interrupted'
]
const ACTIVITY_TYPES: readonly ActivityType[] = [
  'thinking',
  'tool',
  'command',
  'file_read',
  'file_write',
  'file_edit',
  'search',
  'web',
  'task',
  'todo',
  'mcp',
  'notebook',
  'error'
]
const ACTIVITY_STATUSES: readonly ActivityStatus[] = ['running', 'success', 'error', 'cancelled']
const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'success', 'error', 'cancelled', 'interrupted']
const ATTACHMENT_KINDS: readonly Attachment['kind'][] = ['file', 'folder', 'image']

export function asAccent(value: unknown): BotAccent {
  return oneOf(BOT_ACCENTS, value, 'violet')
}

export function asAccentOrNull(value: unknown): BotAccent | null {
  return value === null || value === undefined ? null : asAccent(value)
}

/** Falls back to the product's default avatar style, matching the column default. */
export function asAvatarType(value: unknown): AvatarType {
  return oneOf(AVATAR_TYPES, value, 'shape')
}

export function asMessageStatus(value: unknown): MessageStatus {
  return oneOf(MESSAGE_STATUSES, value, 'complete')
}

/** Free-form on purpose: users may pin a full model id such as `claude-opus-4-20250514`. */
function asModel(value: unknown): ModelPreference {
  return typeof value === 'string' && value.length > 0 ? value : 'default'
}

/** Tool lists are stored as a JSON array of strings; a corrupt blob degrades to `[]`. */
export function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function parseUsage(json: string | null | undefined): MessageUsage | null {
  if (!json) return null
  try {
    const raw: unknown = JSON.parse(json)
    if (!raw || typeof raw !== 'object') return null
    const u = raw as Record<string, unknown>
    return {
      inputTokens: numberOr(u.inputTokens, 0),
      outputTokens: numberOr(u.outputTokens, 0),
      cacheReadInputTokens: numberOr(u.cacheReadInputTokens, 0),
      cacheCreationInputTokens: numberOr(u.cacheCreationInputTokens, 0),
      costUsd: numberOrNull(u.costUsd),
      durationMs: numberOrNull(u.durationMs),
      numTurns: numberOrNull(u.numTurns),
      model: typeof u.model === 'string' ? u.model : null
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Row -> domain
 * ------------------------------------------------------------------ */

export function rowToBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    avatarType: asAvatarType(row.avatar_type),
    avatarValue: row.avatar_value,
    accent: asAccent(row.accent),
    defaultWorkingDirectory: row.default_working_directory,
    model: asModel(row.model),
    permissionMode: oneOf(PERMISSION_MODES, row.permission_mode, 'default'),
    allowedTools: parseStringArray(row.allowed_tools),
    disallowedTools: parseStringArray(row.disallowed_tools),
    pinned: toBool(row.pinned),
    hidden: toBool(row.hidden),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function rowToConversation(row: ConversationRow, memberBotIds: string[]): Conversation {
  return {
    id: row.id,
    type: oneOf(CONVERSATION_TYPES, row.type, 'group'),
    name: row.name,
    icon: row.icon,
    memberBotIds,
    workspaceDirectory: row.workspace_directory,
    defaultResponderBotId: row.default_responder_bot_id,
    skipEveryoneConfirm: toBool(row.skip_everyone_confirm),
    pinned: toBool(row.pinned),
    hidden: toBool(row.hidden),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function rowToMention(row: MentionRow): MessageMention {
  return {
    botId: row.bot_id,
    display: row.display,
    everyone: toBool(row.everyone),
    startIndex: row.start_index,
    endIndex: row.end_index
  }
}

export function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    path: row.path,
    name: row.name,
    kind: oneOf(ATTACHMENT_KINDS, row.kind, 'file'),
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    missing: toBool(row.missing),
    createdAt: row.created_at
  }
}

export function rowToActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    messageId: row.message_id,
    botId: row.bot_id,
    type: oneOf(ACTIVITY_TYPES, row.type, 'tool'),
    title: row.title,
    subtitle: row.subtitle,
    detail: row.detail,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id,
    status: oneOf(ACTIVITY_STATUSES, row.status, 'running'),
    addedLines: row.added_lines,
    removedLines: row.removed_lines,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seq: row.seq
  }
}

export function rowToJob(row: JobRow): BotJob {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    triggeringMessageId: row.triggering_message_id,
    responseMessageId: row.response_message_id,
    status: oneOf(JOB_STATUSES, row.status, 'queued'),
    handoffDepth: row.handoff_depth,
    originMessageId: row.origin_message_id,
    processPid: row.process_pid,
    claudeSessionId: row.claude_session_id,
    errorText: row.error_text,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

export function rowToSession(row: SessionRow): BotConversationSession {
  return {
    botId: row.bot_id,
    conversationId: row.conversation_id,
    claudeSessionId: row.claude_session_id,
    lastSeenMessageId: row.last_seen_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Single-user app: a stored reaction row is by definition the user's own. */
export function rowToReaction(row: ReactionRow): Reaction {
  return { emoji: row.emoji, count: 1, mine: true }
}

export interface MessageRelations {
  mentions: MessageMention[]
  attachments: Attachment[]
  activities: Activity[]
  reactions: Reaction[]
}

const EMPTY_RELATIONS: MessageRelations = { mentions: [], attachments: [], activities: [], reactions: [] }

export function rowToMessage(row: MessageRow, relations: MessageRelations = EMPTY_RELATIONS): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorType: oneOf(AUTHOR_TYPES, row.author_type, 'system'),
    authorBotId: row.author_bot_id,
    authorName: row.author_name,
    authorAvatarType: row.author_avatar_type === null ? null : asAvatarType(row.author_avatar_type),
    authorAvatarValue: row.author_avatar_value,
    authorAccent: asAccentOrNull(row.author_accent),
    bodyMarkdown: row.body_markdown,
    thinkingMarkdown: row.thinking_markdown,
    replyToMessageId: row.reply_to_message_id,
    status: asMessageStatus(row.status),
    systemKind: row.system_kind === null ? null : oneOf(SYSTEM_KINDS, row.system_kind, 'generic'),
    handoffFromBotId: row.handoff_from_bot_id,
    jobId: row.job_id,
    errorText: row.error_text,
    mentions: relations.mentions,
    attachments: relations.attachments,
    activities: relations.activities,
    reactions: relations.reactions,
    usage: parseUsage(row.usage_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

const PREVIEW_MAX_CHARS = 120

/**
 * Flatten markdown into the one-line preview the sidebar shows.
 *
 * This is intentionally a lexical strip rather than a real parse: it runs for
 * every conversation on every sidebar refresh, and the result is truncated to
 * ~120 characters anyway, so an imperfect edge case costs nothing while a
 * markdown parser here would cost a dependency and a measurable amount of time.
 */
export function previewFromMarkdown(markdown: string | null | undefined, max = PREVIEW_MAX_CHARS): string {
  if (!markdown) return ''

  let text = markdown
    // Fenced code: keep a marker so "here is the patch" previews are not blank.
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/~~~[\s\S]*?~~~/g, ' [code] ')
    // Images before links — the image alt text is the useful part.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Inline code, emphasis, strikethrough markers.
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s.,!?)]|$)/g, '$1$2')
    // Block markers at the start of a line: headings, quotes, list bullets, checkboxes.
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+(\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // Horizontal rules and stray HTML tags.
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')

  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  // Prefer breaking on a word boundary, but never lose more than 20% of the budget.
  const clipped = text.slice(0, max)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > max * 0.8 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
}
