/**
 * Backup export/import and per-conversation Markdown transcripts (PRD §41).
 *
 * Two hard rules shape this file:
 *
 *  1. **Nothing credential-shaped ever leaves the machine.** Claude session ids
 *     are not exported (they are not portable anyway, and they are the closest
 *     thing this app holds to a token), and the detected Claude executable path
 *     is redacted because it is machine-specific noise.
 *  2. **Import is all-or-nothing.** Everything is read and validated first, then
 *     written inside a single SQLite transaction with freshly generated ids. A
 *     failure anywhere rolls the whole thing back and reports a readable reason
 *     instead of leaving a half-restored database.
 *
 * Import is *additive*: ids are regenerated and every reference remapped, so
 * restoring a backup into a populated app merges rather than clobbers.
 */
import { BrowserWindow, app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getDb, transaction } from '@main/db/index'
import { botsRepo } from '@main/db/repositories/bots'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { settingsRepo } from '@main/db/repositories/settings'
import { emit } from '@main/events'
import { newId, nowIso } from '@main/lib/id'
import { log } from '@main/lib/logger'
import { summarizeActivities } from '@main/runtime/ActivityMapper'
import { attachmentInputSchema, modelSchema } from '@shared/schemas'
import type {
  Activity,
  ActivityStatus,
  ActivityType,
  AppSettings,
  Attachment,
  AuthorType,
  AvatarType,
  BotAccent,
  ConversationType,
  MessageMention,
  MessageStatus,
  MessageUsage,
  ModelPreference,
  PermissionMode,
  Reaction,
  SystemMessageKind
} from '@shared/types'

/* ------------------------------------------------------------------ *
 * Export document shapes
 * ------------------------------------------------------------------ */

const BACKUP_FORMAT = 'claude-bot-backup'
const BACKUP_FORMAT_VERSION = 1

interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: string
  /** SQLite `user_version` at export time, so a future import can migrate knowingly. */
  schemaVersion: number
  counts: {
    bots: number
    conversations: number
    messages: number
    activities: number
    attachments: number
  }
  /** Explicit record of what was deliberately left out. */
  redacted: string[]
}

interface ExportBot {
  id: string
  name: string
  title: string | null
  description: string
  avatarType: AvatarType
  avatarValue: string
  accent: BotAccent
  defaultWorkingDirectory: string | null
  model: ModelPreference
  permissionMode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
  pinned: boolean
  hidden: boolean
  archivedAt: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

interface ExportConversation {
  id: string
  type: ConversationType
  name: string
  icon: string | null
  memberBotIds: string[]
  workspaceDirectory: string | null
  defaultResponderBotId: string | null
  skipEveryoneConfirm: boolean
  pinned: boolean
  hidden: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

interface ExportMessage {
  id: string
  conversationId: string
  authorType: AuthorType
  authorBotId: string | null
  authorName: string | null
  authorAvatarType: AvatarType | null
  authorAvatarValue: string | null
  authorAccent: BotAccent | null
  bodyMarkdown: string
  thinkingMarkdown: string
  replyToMessageId: string | null
  status: MessageStatus
  systemKind: SystemMessageKind | null
  handoffFromBotId: string | null
  errorText: string | null
  usage: MessageUsage | null
  seq: number
  createdAt: string
  updatedAt: string
  mentions: MessageMention[]
  attachments: Attachment[]
  activities: Activity[]
  reactions: Reaction[]
}

const REDACTED_FIELDS = [
  'bot_conversation_sessions (Claude session ids)',
  'jobs (process + session bookkeeping)',
  'settings.claudeExecutablePath'
]

/* ------------------------------------------------------------------ *
 * Raw row shapes (mirrors src/main/db/schema.ts migration 1)
 * ------------------------------------------------------------------ */

interface BotRow {
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

interface ConversationRow {
  id: string
  type: string
  name: string
  icon: string | null
  workspace_directory: string | null
  default_responder_bot_id: string | null
  skip_everyone_confirm: number
  pinned: number
  hidden: number
  sort_order: number
  created_at: string
  updated_at: string
}

interface MessageRow {
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
  error_text: string | null
  usage_json: string | null
  seq: number
  created_at: string
  updated_at: string
}

interface MentionRow {
  message_id: string
  bot_id: string | null
  display: string
  everyone: number
  start_index: number
  end_index: number
}

interface AttachmentRow {
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

interface ActivityRow {
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

interface ReactionRow {
  message_id: string
  emoji: string
  created_at: string
}

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function readBots(): ExportBot[] {
  const rows = getDb()
    .prepare('SELECT * FROM bots ORDER BY sort_order, created_at')
    .all() as unknown as BotRow[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    avatarType: r.avatar_type as AvatarType,
    avatarValue: r.avatar_value,
    accent: r.accent as BotAccent,
    defaultWorkingDirectory: r.default_working_directory,
    model: r.model,
    permissionMode: r.permission_mode as PermissionMode,
    allowedTools: parseJsonArray(r.allowed_tools),
    disallowedTools: parseJsonArray(r.disallowed_tools),
    pinned: r.pinned === 1,
    hidden: r.hidden === 1,
    archivedAt: r.archived_at,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

function readConversations(): ExportConversation[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY sort_order, created_at')
    .all() as unknown as ConversationRow[]
  const memberRows = db
    .prepare('SELECT conversation_id, bot_id FROM conversation_members ORDER BY position')
    .all() as unknown as Array<{ conversation_id: string; bot_id: string }>

  const membersByConversation = new Map<string, string[]>()
  for (const row of memberRows) {
    const list = membersByConversation.get(row.conversation_id)
    if (list) list.push(row.bot_id)
    else membersByConversation.set(row.conversation_id, [row.bot_id])
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type as ConversationType,
    name: r.name,
    icon: r.icon,
    memberBotIds: membersByConversation.get(r.id) ?? [],
    workspaceDirectory: r.workspace_directory,
    defaultResponderBotId: r.default_responder_bot_id,
    skipEveryoneConfirm: r.skip_everyone_confirm === 1,
    pinned: r.pinned === 1,
    hidden: r.hidden === 1,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

function parseUsage(raw: string | null): MessageUsage | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as MessageUsage) : null
  } catch {
    return null
  }
}

/**
 * Load messages with everything hanging off them, in one pass per child table.
 * `conversationId` narrows to a single conversation for the Markdown export;
 * omit it for a full backup.
 */
function readMessages(conversationId?: string): ExportMessage[] {
  const db = getDb()
  const where = conversationId ? 'WHERE conversation_id = ?' : ''
  const params = conversationId ? [conversationId] : []

  const rows = db
    .prepare(`SELECT * FROM messages ${where} ORDER BY conversation_id, seq, created_at`)
    .all(...params) as unknown as MessageRow[]

  if (rows.length === 0) return []

  const idFilter = conversationId
    ? 'WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)'
    : ''

  const mentionRows = db
    .prepare(`SELECT * FROM message_mentions ${idFilter} ORDER BY id`)
    .all(...params) as unknown as MentionRow[]
  const attachmentRows = db
    .prepare(`SELECT * FROM attachments ${idFilter} ORDER BY created_at`)
    .all(...params) as unknown as AttachmentRow[]
  const activityRows = db
    .prepare(`SELECT * FROM activities ${idFilter} ORDER BY seq`)
    .all(...params) as unknown as ActivityRow[]
  const reactionRows = db
    .prepare(`SELECT * FROM reactions ${idFilter} ORDER BY created_at`)
    .all(...params) as unknown as ReactionRow[]

  const mentions = groupBy(mentionRows, (r) => r.message_id)
  const attachments = groupBy(attachmentRows, (r) => r.message_id)
  const activities = groupBy(activityRows, (r) => r.message_id)
  const reactions = groupBy(reactionRows, (r) => r.message_id)

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    authorType: r.author_type as AuthorType,
    authorBotId: r.author_bot_id,
    authorName: r.author_name,
    authorAvatarType: r.author_avatar_type as AvatarType | null,
    authorAvatarValue: r.author_avatar_value,
    authorAccent: r.author_accent as BotAccent | null,
    bodyMarkdown: r.body_markdown,
    thinkingMarkdown: r.thinking_markdown,
    replyToMessageId: r.reply_to_message_id,
    status: r.status as MessageStatus,
    systemKind: r.system_kind as SystemMessageKind | null,
    handoffFromBotId: r.handoff_from_bot_id,
    errorText: r.error_text,
    usage: parseUsage(r.usage_json),
    seq: r.seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mentions: (mentions.get(r.id) ?? []).map((m) => ({
      botId: m.bot_id,
      display: m.display,
      everyone: m.everyone === 1,
      startIndex: m.start_index,
      endIndex: m.end_index
    })),
    attachments: (attachments.get(r.id) ?? []).map((a) => ({
      id: a.id,
      messageId: a.message_id,
      path: a.path,
      name: a.name,
      kind: a.kind as Attachment['kind'],
      sizeBytes: a.size_bytes,
      mimeType: a.mime_type,
      missing: a.missing === 1,
      createdAt: a.created_at
    })),
    activities: (activities.get(r.id) ?? []).map((a) => ({
      id: a.id,
      messageId: a.message_id,
      botId: a.bot_id,
      type: a.type as ActivityType,
      title: a.title,
      subtitle: a.subtitle,
      detail: a.detail,
      toolName: a.tool_name,
      toolUseId: a.tool_use_id,
      status: a.status as ActivityStatus,
      addedLines: a.added_lines,
      removedLines: a.removed_lines,
      startedAt: a.started_at,
      endedAt: a.ended_at,
      seq: a.seq
    })),
    // The reactions table stores one row per emoji with no counter — this app is
    // single-user, so every stored reaction is the user's own.
    reactions: (reactions.get(r.id) ?? []).map((x) => ({ emoji: x.emoji, count: 1, mine: true }))
  }))
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = map.get(k)
    if (list) list.push(row)
    else map.set(k, [row])
  }
  return map
}

function schemaVersion(): number {
  const value = getDb().pragma('user_version', { simple: true })
  return typeof value === 'number' ? value : 0
}

/* ------------------------------------------------------------------ *
 * Dialog helpers
 * ------------------------------------------------------------------ */

function parentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/** Filesystem-safe filename fragment. Conversation names are free text. */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'conversation').slice(0, 80)
}

/* ------------------------------------------------------------------ *
 * exportBackup
 * ------------------------------------------------------------------ */

export async function exportBackup(): Promise<{ path: string | null }> {
  const win = parentWindow()
  const defaultPath = join(app.getPath('documents'), 'claude-bot-export')
  const options = {
    title: 'Export backup',
    defaultPath,
    buttonLabel: 'Export',
    // The user picks a *folder name*; we create it and write the five files in.
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const]
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { path: null }

  const target = result.filePath

  // Snapshot everything first so the files that land on disk are internally
  // consistent even if a Bot finishes mid-export.
  const bots = readBots()
  const conversations = readConversations()
  const messages = readMessages()
  const settings = settingsRepo.get()

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: app.getVersion(),
    exportedAt: nowIso(),
    schemaVersion: schemaVersion(),
    counts: {
      bots: bots.length,
      conversations: conversations.length,
      messages: messages.length,
      activities: messages.reduce((n, m) => n + m.activities.length, 0),
      attachments: messages.reduce((n, m) => n + m.attachments.length, 0)
    },
    redacted: REDACTED_FIELDS
  }

  // The executable path is a local detail of *this* machine and would be wrong
  // (or an unwanted disclosure) anywhere else.
  const exportedSettings: AppSettings = { ...settings, claudeExecutablePath: null }

  await mkdir(target, { recursive: true })
  await Promise.all([
    writeJsonFile(join(target, 'manifest.json'), manifest),
    writeJsonFile(join(target, 'bots.json'), bots),
    writeJsonFile(join(target, 'conversations.json'), conversations),
    writeJsonFile(join(target, 'messages.json'), messages),
    writeJsonFile(join(target, 'settings.json'), exportedSettings)
  ])

  log.info('export', `wrote backup to ${target}`, manifest.counts)
  return { path: target }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * importBackup
 * ------------------------------------------------------------------ */

export async function importBackup(): Promise<{ imported: boolean; error?: string }> {
  const win = parentWindow()
  const options = {
    title: 'Import backup',
    buttonLabel: 'Import',
    properties: ['openDirectory' as const]
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return { imported: false }

  const folder = picked.filePaths[0]

  // Phase 1 — read and validate. Nothing touches the database yet.
  let manifest: BackupManifest
  let bots: unknown[]
  let conversations: unknown[]
  let messages: unknown[]
  let settings: Record<string, unknown>
  try {
    manifest = validateManifest(await readJsonFile(join(folder, 'manifest.json')))
    bots = expectArray(await readJsonFile(join(folder, 'bots.json')), 'bots.json')
    conversations = expectArray(
      await readJsonFile(join(folder, 'conversations.json')),
      'conversations.json'
    )
    messages = expectArray(await readJsonFile(join(folder, 'messages.json')), 'messages.json')
    const rawSettings = await readJsonFile(join(folder, 'settings.json'))
    settings =
      rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
        ? (rawSettings as Record<string, unknown>)
        : {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('import', 'backup validation failed', message)
    return { imported: false, error: message }
  }

  // Phase 1b — a backup is a file someone can send you, and it can ask for
  // capability this app will not grant it (see the note on `applyImport`). Say
  // which parts are being dropped before anything is written: the import toast
  // is a single line and would otherwise report a plain success while the user's
  // restored Bots quietly came back without their folders and tools.
  const declined = declinedGrants({ bots, conversations, settings })
  if (declined.length > 0) {
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Import without them'],
      defaultId: 1,
      cancelId: 0,
      title: 'Import backup?',
      message: 'This backup asks for permissions that will not be restored.',
      detail: `${declined.map((line) => `• ${line}`).join('\n')}\n\nAnything in a backup that decides what a Bot may do — its working folder, its pre-approved tools, its permission mode — is left for you to set yourself afterwards. Bots, chats, messages and attachments are restored as usual.`
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (response !== 1) {
      log.info('import', 'user cancelled an import that requested capability', { folder })
      return { imported: false }
    }
  }

  // Phase 2 — one transaction. Any throw rolls the whole import back.
  try {
    const outcome = transaction(() => applyImport({ bots, conversations, messages, settings }))
    log.info('import', `imported backup from ${folder}`, {
      appVersion: manifest.appVersion,
      bots: outcome.botIds.length,
      conversations: outcome.conversationIds.length,
      messages: outcome.messageCount
    })

    // Emitted after the commit so the renderer never sees rows that got rolled back.
    for (const id of outcome.botIds) {
      const bot = botsRepo.get(id)
      if (bot) emit('bot:created', { bot })
    }
    for (const id of outcome.conversationIds) {
      const conversation = conversationsRepo.getSummary(id)
      if (conversation) emit('conversation:created', { conversation })
    }
    if (outcome.settingsApplied) emit('settings:updated', { settings: settingsRepo.get() })

    return { imported: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('import', 'backup import rolled back', err)
    return { imported: false, error: message }
  }
}

/**
 * The capability a backup asks for and will not get, phrased for a dialog.
 * Empty for an ordinary backup, which imports with no extra prompt.
 *
 * Only unconditional grants are listed — the ones that widen capability no
 * matter what the user's current settings are. `handoffsEnabled` and the loop
 * budgets are clamped against those settings instead
 * (`clampImportedSetting`), so a backup cannot widen them and they need no
 * sentence here.
 */
function declinedGrants(input: {
  bots: unknown[]
  conversations: unknown[]
  settings: Record<string, unknown>
}): string[] {
  const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const lines: string[] = []

  let folders = 0
  let toolLists = 0
  let autoEdits = 0
  for (const raw of input.bots) {
    const record = asRecord(raw)
    if (!record) continue
    if (asString(record['defaultWorkingDirectory'])) folders += 1
    if (asStringArray(record['allowedTools']).length > 0) toolLists += 1
    const mode = asText(record['permissionMode'], 'default')
    if (mode !== 'default' && mode !== 'plan') autoEdits += 1
  }
  if (folders > 0) lines.push(`${plural(folders, 'Bot')} with a folder to run in`)
  if (toolLists > 0) lines.push(`${plural(toolLists, 'Bot')} with a pre-approved tool list`)
  if (autoEdits > 0) {
    lines.push(`${plural(autoEdits, 'Bot')} set to act on files without asking`)
  }

  let workspaces = 0
  let skipConfirm = 0
  for (const raw of input.conversations) {
    const record = asRecord(raw)
    if (!record) continue
    if (asString(record['workspaceDirectory'])) workspaces += 1
    if (asBool(record['skipEveryoneConfirm'])) skipConfirm += 1
  }
  if (workspaces > 0) lines.push(`${plural(workspaces, 'chat')} with a workspace folder`)
  if (skipConfirm > 0) {
    lines.push(`${plural(skipConfirm, 'chat')} set to skip the @everyone confirmation`)
  }

  const settings = input.settings
  const globalMode = asText(settings['defaultPermissionMode'], 'default')
  if (
    asStringArray(settings['globalAllowedTools']).length > 0 ||
    (globalMode !== 'default' && globalMode !== 'plan') ||
    settings['safetyGuardrails'] === false
  ) {
    lines.push('app-wide settings that would widen what every Bot you already have may do')
  }

  return lines
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`Missing ${basenameOf(path)} — this folder is not a Claude Bot backup.`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${basenameOf(path)} is not valid JSON.`)
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must contain a JSON array.`)
  return value
}

function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest.json must contain a JSON object.')
  }
  const record = value as Record<string, unknown>
  if (record['format'] !== BACKUP_FORMAT) {
    throw new Error('This folder is not a Claude Bot backup.')
  }
  const version = record['formatVersion']
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('manifest.json is missing a formatVersion.')
  }
  if (version > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was written by a newer version of Claude Bot (format ${version}). Update the app and try again.`
    )
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: version,
    appVersion: asString(record['appVersion']) ?? 'unknown',
    exportedAt: asString(record['exportedAt']) ?? nowIso(),
    schemaVersion: asInt(record['schemaVersion']) ?? 0,
    counts: {
      bots: 0,
      conversations: 0,
      messages: 0,
      activities: 0,
      attachments: 0
    },
    redacted: REDACTED_FIELDS
  }
}

/* --- coercion helpers: backups are user-supplied files, treat them as hostile --- */

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBool(value: unknown): boolean {
  return value === true || value === 1
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * A model id out of a backup, or `default`.
 *
 * The value is interpolated into argv as `--model <value>`, so it is held to the
 * composer's own `modelSchema` — and then to one rule that schema does not have:
 * a leading `-` is refused. `modelSchema`'s charset allows dashes anywhere, so a
 * backup could name a model `--dangerously-skip-permissions` and hand the CLI's
 * argument parser a second flag where a value belongs. No real model id starts
 * with a dash.
 */
function importedModel(value: unknown): string {
  const parsed = modelSchema.safeParse(value)
  return parsed.success && !parsed.data.startsWith('-') ? parsed.data : 'default'
}

/**
 * Tool patterns out of a backup. Only the DISALLOW list is imported at all (see
 * `applyImport`), and a pattern that matches no tool is inert, so the caps here
 * are about size rather than syntax: the same 200 characters and 200 entries
 * `toolNameSchema` enforces in the composer, so a restore cannot push a
 * megabyte of junk into the CLI's argv. The charset is not re-checked because
 * these strings only ever travel as an argv array with `shell: false`.
 */
function importedToolPatterns(value: unknown): string[] {
  return asStringArray(value)
    .filter((pattern) => pattern.length > 0 && pattern.length <= 200)
    .slice(0, 200)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Message statuses that only make sense while a process is alive. A restored
 * backup has no jobs behind them, so they would render as permanently spinning
 * placeholders — mark them interrupted instead.
 */
function importedStatus(raw: unknown): MessageStatus {
  const status = asString(raw)
  switch (status) {
    case 'complete':
    case 'error':
    case 'cancelled':
    case 'interrupted':
      return status
    case 'streaming':
    case 'queued':
    case 'running':
      return 'interrupted'
    default:
      return 'complete'
  }
}

interface ImportOutcome {
  botIds: string[]
  conversationIds: string[]
  messageCount: number
  settingsApplied: boolean
}

/**
 * Preference keys that are safe to restore. Deliberately excluded:
 * `claudeExecutablePath` and `defaultWorkspace` (paths from another machine),
 * `launchAtLogin` (an OS-level registration this app did not make here),
 * `onboardingCompleted` (would strand a first-run user with no setup flow), and
 * — see `clampImportedSetting` — `globalAllowedTools` and
 * `defaultPermissionMode`, which apply to every Bot the user already has and so
 * are the widest grant in the whole file.
 */
const IMPORTABLE_SETTING_KEYS = [
  'appearance',
  'showNotifications',
  'notifyOnFocusedConversation',
  'maxConcurrentBots',
  'allowSameBotConcurrentConversations',
  'defaultModel',
  'globalDisallowedTools',
  'safetyGuardrails',
  'handoffsEnabled',
  'maxHandoffDepth',
  'maxAutomatedTurnsPerHumanMessage',
  'groupBridgeCharBudget',
  'showThinking',
  'sendKey',
  'fontScale'
] as const satisfies ReadonlyArray<keyof AppSettings>

/**
 * Settings that decide what a Bot may DO, clamped so a restore can only ever
 * narrow them. Returns the value to write, or `undefined` to ignore this key.
 *
 * The rule for the whole importer (see `applyImport`) is grants vs restrictions:
 * a backup may restore anything that narrows what a Bot can do and nothing that
 * widens it. These four are the settings-level half of that.
 *
 * `globalDisallowedTools` is unioned rather than replaced, because
 * `settingsRepo.update` overwrites an array wholesale — restoring `[]` over a
 * user's own disallow list would be a grant wearing a restriction's clothes.
 */
function clampImportedSetting(
  key: (typeof IMPORTABLE_SETTING_KEYS)[number],
  value: unknown,
  current: AppSettings
): unknown {
  switch (key) {
    // Turning the guardrails back ON is fine; turning them off is not.
    case 'safetyGuardrails':
      return value === true ? true : undefined
    // Likewise the Bot-to-Bot kill switch: a backup may close it, never open it.
    case 'handoffsEnabled':
      return value === false ? false : undefined
    // Loop budgets: a lower ceiling is a restriction, a higher one buys an
    // imported Bot more automated turns against the user's quota.
    case 'maxHandoffDepth':
    case 'maxAutomatedTurnsPerHumanMessage': {
      const next = asInt(value)
      return next !== null && next < current[key] ? next : undefined
    }
    case 'globalDisallowedTools':
      return [...new Set([...current.globalDisallowedTools, ...asStringArray(value)])]
    default:
      return value
  }
}

function applyImport(input: {
  bots: unknown[]
  conversations: unknown[]
  messages: unknown[]
  settings: Record<string, unknown>
}): ImportOutcome {
  const db = getDb()
  const now = nowIso()

  const botIdMap = new Map<string, string>()
  const conversationIdMap = new Map<string, string>()
  const messageIdMap = new Map<string, string>()

  /* ---- bots ---- */

  const existingNames = new Set(
    (db.prepare('SELECT name FROM bots').all() as unknown as Array<{ name: string }>).map((r) =>
      r.name.toLowerCase()
    )
  )

  const insertBot = db.prepare(`
    INSERT INTO bots (
      id, name, title, description, avatar_type, avatar_value, accent,
      default_working_directory, model, permission_mode, allowed_tools, disallowed_tools,
      pinned, hidden, archived_at, sort_order, created_at, updated_at
    ) VALUES (
      @id, @name, @title, @description, @avatar_type, @avatar_value, @accent,
      @default_working_directory, @model, @permission_mode, @allowed_tools, @disallowed_tools,
      @pinned, @hidden, @archived_at, @sort_order, @created_at, @updated_at
    )
  `)

  const botIds: string[] = []
  for (const raw of input.bots) {
    const record = asRecord(raw)
    if (!record) continue
    const oldId = asString(record['id'])
    if (!oldId) continue

    const id = newId('bot')
    const name = uniqueBotName(asText(record['name'], 'Imported Bot'), existingNames)
    existingNames.add(name.toLowerCase())

    // Capability comes from the user, never from the file. See the grants-vs-
    // restrictions note on applyImport: a backup used to write
    // `allowedTools: ["Bash"]`, `defaultWorkingDirectory: "/"` and
    // `hidden: true` straight through, so opening someone's .zip installed a
    // Bot that spawned `claude -p --allowedTools Bash` with cwd `/` on the
    // user's first message. Restrictions (`disallowedTools`, `plan`) survive.
    insertBot.run({
      id,
      name,
      title: asString(record['title']),
      description: asText(record['description']),
      avatar_type: asText(record['avatarType'], 'shape'),
      avatar_value: asText(record['avatarValue'], 'circle'),
      accent: asText(record['accent'], 'violet'),
      default_working_directory: null,
      model: importedModel(record['model']),
      permission_mode: asText(record['permissionMode']) === 'plan' ? 'plan' : 'default',
      allowed_tools: '[]',
      disallowed_tools: JSON.stringify(importedToolPatterns(record['disallowedTools'])),
      pinned: 0,
      hidden: 0,
      archived_at: asString(record['archivedAt']),
      sort_order: asInt(record['sortOrder']) ?? 0,
      created_at: asString(record['createdAt']) ?? now,
      updated_at: asString(record['updatedAt']) ?? now
    })

    botIdMap.set(oldId, id)
    botIds.push(id)
  }

  /* ---- conversations + members ---- */

  const insertConversation = db.prepare(`
    INSERT INTO conversations (
      id, type, name, icon, workspace_directory, default_responder_bot_id,
      skip_everyone_confirm, pinned, hidden, last_read_at, sort_order, created_at, updated_at
    ) VALUES (
      @id, @type, @name, @icon, @workspace_directory, @default_responder_bot_id,
      @skip_everyone_confirm, @pinned, @hidden, @last_read_at, @sort_order, @created_at, @updated_at
    )
  `)
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO conversation_members (conversation_id, bot_id, position, created_at)
    VALUES (?, ?, ?, ?)
  `)

  const conversationIds: string[] = []
  for (const raw of input.conversations) {
    const record = asRecord(raw)
    if (!record) continue
    const oldId = asString(record['id'])
    if (!oldId) continue

    const id = newId('conv')
    const type = asText(record['type'], 'group') === 'direct' ? 'direct' : 'group'
    const defaultResponder = asString(record['defaultResponderBotId'])

    insertConversation.run({
      id,
      type,
      name: asText(record['name'], 'Imported conversation'),
      icon: asString(record['icon']),
      // Same rule as the Bot rows above: a workspace is a grant (it is the cwd
      // of a spawned process), skipping the @everyone confirmation removes a
      // consent step, and `pinned` is how an imported chat put itself at the top
      // of the sidebar. None of the three is restored from a file.
      workspace_directory: null,
      default_responder_bot_id: defaultResponder ? (botIdMap.get(defaultResponder) ?? null) : null,
      skip_everyone_confirm: 0,
      pinned: 0,
      hidden: asBool(record['hidden']) ? 1 : 0,
      // Everything imported reads as already seen; a restore should not light up
      // the sidebar with hundreds of fake unread messages.
      last_read_at: now,
      sort_order: asInt(record['sortOrder']) ?? 0,
      created_at: asString(record['createdAt']) ?? now,
      updated_at: asString(record['updatedAt']) ?? now
    })

    let position = 0
    for (const memberId of asStringArray(record['memberBotIds'])) {
      const mapped = botIdMap.get(memberId)
      // A member whose Bot is absent from the backup is silently dropped: the
      // foreign key would reject it and the conversation is still useful.
      if (!mapped) continue
      insertMember.run(id, mapped, position, now)
      position += 1
    }

    conversationIdMap.set(oldId, id)
    conversationIds.push(id)
  }

  /* ---- messages (pass 1: rows) ---- */

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, author_type, author_bot_id, author_name, author_avatar_type,
      author_avatar_value, author_accent, body_markdown, thinking_markdown, reply_to_message_id,
      status, system_kind, handoff_from_bot_id, job_id, error_text, usage_json, seq,
      created_at, updated_at
    ) VALUES (
      @id, @conversation_id, @author_type, @author_bot_id, @author_name, @author_avatar_type,
      @author_avatar_value, @author_accent, @body_markdown, @thinking_markdown, @reply_to_message_id,
      @status, @system_kind, @handoff_from_bot_id, NULL, @error_text, @usage_json, @seq,
      @created_at, @updated_at
    )
  `)
  const insertMention = db.prepare(`
    INSERT INTO message_mentions (message_id, bot_id, display, everyone, start_index, end_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (id, message_id, path, name, kind, size_bytes, mime_type, missing, created_at)
    VALUES (@id, @message_id, @path, @name, @kind, @size_bytes, @mime_type, @missing, @created_at)
  `)
  const insertActivity = db.prepare(`
    INSERT INTO activities (
      id, message_id, bot_id, type, title, subtitle, detail, tool_name, tool_use_id,
      status, added_lines, removed_lines, started_at, ended_at, seq
    ) VALUES (
      @id, @message_id, @bot_id, @type, @title, @subtitle, @detail, @tool_name, @tool_use_id,
      @status, @added_lines, @removed_lines, @started_at, @ended_at, @seq
    )
  `)
  const insertReaction = db.prepare(`
    INSERT OR IGNORE INTO reactions (message_id, emoji, created_at) VALUES (?, ?, ?)
  `)
  const updateReplyTo = db.prepare('UPDATE messages SET reply_to_message_id = ? WHERE id = ?')

  // Reply targets can point forward as well as backward, so ids are allocated
  // for every message first and the reply column is patched in a second pass.
  const pending: Array<{ id: string; record: Record<string, unknown> }> = []
  for (const raw of input.messages) {
    const record = asRecord(raw)
    if (!record) continue
    const oldId = asString(record['id'])
    if (!oldId) continue
    const id = newId('msg')
    messageIdMap.set(oldId, id)
    pending.push({ id, record })
  }

  let messageCount = 0
  let droppedAttachments = 0
  for (const { id, record } of pending) {
    const oldConversationId = asString(record['conversationId'])
    const conversationId = oldConversationId ? conversationIdMap.get(oldConversationId) : undefined
    // A message whose conversation is not in the backup has nowhere to live.
    if (!conversationId) continue

    const authorTypeRaw = asText(record['authorType'], 'system')
    const authorType: AuthorType =
      authorTypeRaw === 'user' || authorTypeRaw === 'bot' ? authorTypeRaw : 'system'
    const oldAuthorBotId = asString(record['authorBotId'])
    const handoffFrom = asString(record['handoffFromBotId'])
    const usage = asRecord(record['usage'])

    insertMessage.run({
      id,
      conversation_id: conversationId,
      author_type: authorType,
      author_bot_id: oldAuthorBotId ? (botIdMap.get(oldAuthorBotId) ?? null) : null,
      author_name: asString(record['authorName']),
      author_avatar_type: asString(record['authorAvatarType']),
      author_avatar_value: asString(record['authorAvatarValue']),
      author_accent: asString(record['authorAccent']),
      body_markdown: asText(record['bodyMarkdown']),
      thinking_markdown: asText(record['thinkingMarkdown']),
      reply_to_message_id: null,
      status: importedStatus(record['status']),
      system_kind: asString(record['systemKind']),
      handoff_from_bot_id: handoffFrom ? (botIdMap.get(handoffFrom) ?? null) : null,
      error_text: asString(record['errorText']),
      usage_json: usage ? JSON.stringify(usage) : null,
      seq: asInt(record['seq']) ?? messageCount,
      created_at: asString(record['createdAt']) ?? now,
      updated_at: asString(record['updatedAt']) ?? now
    })
    messageCount += 1

    for (const rawMention of Array.isArray(record['mentions']) ? record['mentions'] : []) {
      const mention = asRecord(rawMention)
      if (!mention) continue
      const mentionBotId = asString(mention['botId'])
      insertMention.run(
        id,
        mentionBotId ? (botIdMap.get(mentionBotId) ?? null) : null,
        asText(mention['display'], '@'),
        asBool(mention['everyone']) ? 1 : 0,
        asInt(mention['startIndex']) ?? 0,
        asInt(mention['endIndex']) ?? 0
      )
    }

    for (const rawAttachment of Array.isArray(record['attachments']) ? record['attachments'] : []) {
      const attachment = asRecord(rawAttachment)
      if (!attachment) continue
      const path = asString(attachment['path'])
      if (!path) continue

      // An attachment is a POINTER INTO THE USER'S FILESYSTEM that the backup
      // supplies in full, so it gets the same validation as one arriving over
      // IPC. Anything that fails is dropped rather than repaired: a malformed
      // attachment is not worth resurrecting.
      const validated = attachmentInputSchema.safeParse({
        path,
        // Never trust a supplied display name. Every attachment the app itself
        // creates is named after its own file (`describeFile`), so deriving it
        // here is lossless for a real backup — and it stops a hostile one from
        // labelling `payload.command` as "Q3-report.pdf" on the chip, where the
        // real path is only visible on hover.
        name: basenameOf(path),
        kind: asText(attachment['kind'], 'file'),
        sizeBytes: asInt(attachment['sizeBytes']),
        mimeType: asString(attachment['mimeType'])
      })
      if (!validated.success) {
        droppedAttachments += 1
        continue
      }

      insertAttachment.run({
        id: newId('att'),
        message_id: id,
        path: validated.data.path,
        name: validated.data.name,
        kind: validated.data.kind,
        size_bytes: validated.data.sizeBytes ?? null,
        mime_type: validated.data.mimeType ?? null,
        // Measured, not imported. The exporting machine's answer says nothing
        // about this one, and `missing` is what greys the chip out and makes it
        // unclickable — a backup must not get to decide that.
        missing: existsSync(validated.data.path) ? 0 : 1,
        created_at: asString(attachment['createdAt']) ?? now
      })
    }

    let activitySeq = 0
    for (const rawActivity of Array.isArray(record['activities']) ? record['activities'] : []) {
      const activity = asRecord(rawActivity)
      if (!activity) continue
      const activityBotId = asString(activity['botId'])
      insertActivity.run({
        id: newId('act'),
        message_id: id,
        bot_id: activityBotId ? (botIdMap.get(activityBotId) ?? null) : null,
        type: asText(activity['type'], 'tool'),
        title: asText(activity['title'], 'Activity'),
        subtitle: asString(activity['subtitle']),
        detail: asString(activity['detail']),
        tool_name: asString(activity['toolName']),
        tool_use_id: asString(activity['toolUseId']),
        status: asText(activity['status'], 'success'),
        added_lines: asInt(activity['addedLines']),
        removed_lines: asInt(activity['removedLines']),
        started_at: asString(activity['startedAt']) ?? now,
        ended_at: asString(activity['endedAt']),
        seq: asInt(activity['seq']) ?? activitySeq
      })
      activitySeq += 1
    }

    for (const rawReaction of Array.isArray(record['reactions']) ? record['reactions'] : []) {
      const reaction = asRecord(rawReaction)
      const emoji = reaction ? asString(reaction['emoji']) : null
      if (!emoji) continue
      insertReaction.run(id, emoji, now)
    }
  }

  if (droppedAttachments > 0) {
    log.warn('export', `dropped ${droppedAttachments} attachment(s) that failed validation`)
  }

  /* ---- messages (pass 2: reply links) ---- */

  for (const { id, record } of pending) {
    const oldReplyTo = asString(record['replyToMessageId'])
    if (!oldReplyTo) continue
    const mapped = messageIdMap.get(oldReplyTo)
    if (mapped) updateReplyTo.run(mapped, id)
  }

  /* ---- settings ---- */

  const current = settingsRepo.get()
  const patch: Partial<AppSettings> = {}
  for (const key of IMPORTABLE_SETTING_KEYS) {
    if (!(key in input.settings)) continue
    const value = input.settings[key]
    if (value === null || value === undefined) continue
    // The settings repo re-validates every value it writes, but "the right type"
    // is not the question here: a capability setting has to be clamped so a
    // restore can only narrow it. Anything the clamp declines is left alone.
    const clamped = clampImportedSetting(key, value, current)
    if (clamped === undefined) continue
    // Shape check against the current value, so a string where a number belongs
    // never reaches the repo (its validator would drop it, silently, later).
    if (Array.isArray(clamped) !== Array.isArray(current[key])) continue
    if (!Array.isArray(clamped) && typeof clamped !== typeof current[key]) continue
    ;(patch as Record<string, unknown>)[key] = clamped
  }
  const settingsApplied = Object.keys(patch).length > 0
  if (settingsApplied) settingsRepo.update(patch)

  return { botIds, conversationIds, messageCount, settingsApplied }
}

/** Imported Bots keep their identity but must not silently shadow an existing one. */
function uniqueBotName(name: string, taken: Set<string>): string {
  const base = (name.trim() || 'Imported Bot').slice(0, 40)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (imported${n === 2 ? '' : ` ${n}`})`
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base.slice(0, 28)} (${newId('x').slice(-6)})`
}

/* ------------------------------------------------------------------ *
 * exportConversationMarkdown
 * ------------------------------------------------------------------ */

export async function exportConversationMarkdown(
  conversationId: string
): Promise<{ path: string | null }> {
  const conversation = conversationsRepo.get(conversationId)
  if (!conversation) return { path: null }

  const win = parentWindow()
  const options = {
    title: 'Export conversation',
    defaultPath: join(app.getPath('documents'), `${safeFileName(conversation.name)}.md`),
    buttonLabel: 'Export',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { path: null }

  const members = conversationsRepo.members(conversationId)
  const messages = readMessages(conversationId)
  const markdown = renderMarkdown({
    name: conversation.name,
    type: conversation.type,
    workspace: conversation.workspaceDirectory,
    memberNames: members.map((m) => (m.title ? `${m.name} (${m.title})` : m.name)),
    messages
  })

  await writeFile(result.filePath, markdown, 'utf8')
  log.info('export', `wrote transcript to ${result.filePath}`, { messages: messages.length })
  return { path: result.filePath }
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : TIMESTAMP_FORMAT.format(date)
}

function renderMarkdown(input: {
  name: string
  type: ConversationType
  workspace: string | null
  memberNames: string[]
  messages: ExportMessage[]
}): string {
  const lines: string[] = []

  lines.push(`# ${input.name}`, '')
  lines.push(`_Exported from Claude Bot on ${formatTimestamp(nowIso())}._`, '')
  lines.push(`- **Type:** ${input.type === 'direct' ? 'Direct chat' : 'Group chat'}`)
  if (input.memberNames.length > 0) {
    lines.push(`- **Bots:** ${input.memberNames.join(', ')}`)
  }
  if (input.workspace) {
    lines.push(`- **Workspace:** \`${input.workspace}\``)
  }
  lines.push(`- **Messages:** ${input.messages.length}`)
  lines.push('', '---', '')

  for (const message of input.messages) {
    if (message.authorType === 'system') {
      const body = message.bodyMarkdown.trim() || message.errorText?.trim() || ''
      if (!body) continue
      // System notices are inset cards in the app; a blockquote is the closest
      // Markdown equivalent that survives every renderer.
      lines.push(`> **System** · ${formatTimestamp(message.createdAt)}`)
      for (const line of body.split('\n')) lines.push(`> ${line}`)
      lines.push('')
      continue
    }

    // Assemble the block before emitting the heading: a placeholder that never
    // received any text (an in-flight or abandoned turn) has nothing worth a
    // byline in a transcript, and a bare heading reads like lost content.
    const block: string[] = []

    if (message.attachments.length > 0) {
      const names = message.attachments.map((a) => `\`${a.path}\``).join(', ')
      block.push(`_Attached: ${names}_`, '')
    }

    // Activity before the reply — it is what the Bot did on the way to writing it.
    if (message.activities.length > 0) {
      const summary = summarizeActivities(message.activities)
      if (summary.length > 0) block.push(`_Activity: ${summary.join(' · ')}_`, '')
    }

    const body = message.bodyMarkdown.trim()
    if (body) {
      block.push(body, '')
      if (message.status === 'cancelled') block.push('_(stopped early)_', '')
    } else if (message.errorText) {
      block.push(`_Error: ${message.errorText.trim()}_`, '')
    } else if (message.status === 'cancelled' || message.status === 'interrupted') {
      block.push(`_(${message.status})_`, '')
    } else if (message.status !== 'complete') {
      // streaming / queued / running: the app was still working when the
      // transcript was taken.
      block.push('_(no response recorded)_', '')
    }

    if (block.length === 0) continue

    if (message.reactions.length > 0) {
      block.push(`_Reactions: ${message.reactions.map((r) => r.emoji).join(' ')}_`, '')
    }

    const author = message.authorType === 'user' ? 'You' : (message.authorName ?? 'Bot')
    lines.push(`### ${author} — ${formatTimestamp(message.createdAt)}`, '', ...block)
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
