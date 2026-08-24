/**
 * Conversation repository.
 *
 * The sidebar is the most frequently refreshed surface in the app, so
 * `listSummaries()` is written as three queries total — one for the rows plus
 * their last message and unread count, one for membership, one for live job
 * state — rather than N+1 lookups per conversation.
 */
import type { Bot, Conversation, ConversationSummary } from '@shared/types'
import type { ConversationPatchInput } from '@shared/schemas'
import { getDb, stmt, transaction } from '@main/db/index'
import { AppError } from '@main/lib/errors'
import { newId, nowIso } from '@main/lib/id'
import {
  bindValue,
  fromBool,
  previewFromMarkdown,
  rowToBot,
  rowToConversation,
  type BotRow,
  type ConversationRow
} from '@main/db/rows'

export type ConversationPatch = ConversationPatchInput

export interface CreateGroupInput {
  name: string
  icon?: string | null
  memberBotIds: string[]
  workspaceDirectory?: string | null
}

interface SummaryRow extends ConversationRow {
  last_message_at: string | null
  last_message_body: string | null
  last_message_author_name: string | null
  last_message_author_type: string | null
  /** Needed because an EMPTY newest body is ordinary — see `previewForSummary`. */
  last_message_status: string | null
  unread_count: number
}

const CONVERSATION_COLUMNS = `c.id, c.type, c.name, c.icon, c.workspace_directory,
  c.default_responder_bot_id, c.skip_everyone_confirm, c.pinned, c.hidden, c.last_read_at,
  c.sort_order, c.created_at, c.updated_at`

/**
 * The last message is joined by id rather than aggregated, so the body/author of
 * exactly one row comes back. Ties on `created_at` are broken by `seq`, matching
 * the ordering the transcript itself uses.
 *
 * Unread = anything the user did not write that arrived after `last_read_at`.
 * A NULL `last_read_at` means the conversation was never opened, so everything counts.
 */
const SUMMARY_SELECT = `
  SELECT ${CONVERSATION_COLUMNS},
    lm.created_at   AS last_message_at,
    lm.body_markdown AS last_message_body,
    lm.author_name  AS last_message_author_name,
    lm.author_type  AS last_message_author_type,
    lm.status       AS last_message_status,
    (SELECT COUNT(*) FROM messages um
      WHERE um.conversation_id = c.id
        AND um.author_type IN ('bot', 'system')
        AND (c.last_read_at IS NULL OR um.created_at > c.last_read_at)) AS unread_count
  FROM conversations c
  LEFT JOIN messages lm ON lm.id = (
    SELECT m2.id FROM messages m2
    WHERE m2.conversation_id = c.id
    ORDER BY m2.created_at DESC, m2.seq DESC
    LIMIT 1
  )`

/**
 * Newly created (still empty) conversations fall back to `updated_at` so they
 * appear at the top of the sidebar instead of the bottom.
 */
const SUMMARY_ORDER = 'ORDER BY c.pinned DESC, COALESCE(lm.created_at, c.updated_at) DESC, c.created_at DESC'

const selectSummaries = stmt<SummaryRow>(`${SUMMARY_SELECT} ${SUMMARY_ORDER}`)
const selectSummaryById = stmt<SummaryRow>(`${SUMMARY_SELECT} WHERE c.id = ?`)
const selectById = stmt<ConversationRow>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = ?`)

const selectAllMembers = stmt<{ conversation_id: string; bot_id: string }>(
  'SELECT conversation_id, bot_id FROM conversation_members ORDER BY conversation_id, position ASC'
)
const selectMemberIds = stmt<{ bot_id: string }>(
  'SELECT bot_id FROM conversation_members WHERE conversation_id = ? ORDER BY position ASC'
)
const selectMemberBots = stmt<BotRow>(`
  SELECT b.id, b.name, b.title, b.description, b.avatar_type, b.avatar_value, b.accent,
         b.default_working_directory, b.model, b.permission_mode, b.allowed_tools, b.disallowed_tools,
         b.pinned, b.hidden, b.archived_at, b.sort_order, b.created_at, b.updated_at
  FROM conversation_members cm
  JOIN bots b ON b.id = cm.bot_id
  WHERE cm.conversation_id = ?
  ORDER BY cm.position ASC`)

/** Live scheduler state, used to render the "2 working / 1 queued" header (PRD §23.3). */
const selectActiveJobs = stmt<{ conversation_id: string; bot_id: string; status: string }>(
  "SELECT conversation_id, bot_id, status FROM jobs WHERE status IN ('running', 'queued')"
)

const selectDirectForBot = stmt<ConversationRow>(`
  SELECT ${CONVERSATION_COLUMNS}
  FROM conversations c
  JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.bot_id = ?
  WHERE c.type = 'direct'
  ORDER BY c.created_at ASC
  LIMIT 1`)

const insertConversation = stmt(`
  INSERT INTO conversations (
    id, type, name, icon, workspace_directory, default_responder_bot_id,
    skip_everyone_confirm, pinned, hidden, last_read_at, sort_order, created_at, updated_at
  ) VALUES (
    @id, @type, @name, @icon, @workspace_directory, @default_responder_bot_id,
    @skip_everyone_confirm, 0, 0, NULL, @sort_order, @created_at, @updated_at
  )`)

const insertMember = stmt(`
  INSERT INTO conversation_members (conversation_id, bot_id, position, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (conversation_id, bot_id) DO UPDATE SET position = excluded.position`)

const deleteConversation = stmt('DELETE FROM conversations WHERE id = ?')
const deleteMembership = stmt('DELETE FROM conversation_members WHERE bot_id = ?')
const clearDefaultResponderFor = stmt(
  'UPDATE conversations SET default_responder_bot_id = NULL, updated_at = ? WHERE default_responder_bot_id = ?'
)
const setLastRead = stmt('UPDATE conversations SET last_read_at = ? WHERE id = ?')
const touchConversation = stmt('UPDATE conversations SET updated_at = ? WHERE id = ?')
const unhideConversation = stmt('UPDATE conversations SET hidden = 0, updated_at = ? WHERE id = ?')
const selectNextSortOrder = stmt<{ next: number }>(
  'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM conversations'
)
const selectBotIdsExisting = stmt<{ id: string }>('SELECT id FROM bots WHERE id = ?')

const UPDATABLE: Record<string, { column: string; encode: (v: unknown) => unknown }> = {
  name: { column: 'name', encode: (v) => v },
  icon: { column: 'icon', encode: (v) => v ?? null },
  workspaceDirectory: { column: 'workspace_directory', encode: (v) => v ?? null },
  defaultResponderBotId: { column: 'default_responder_bot_id', encode: (v) => v ?? null },
  skipEveryoneConfirm: { column: 'skip_everyone_confirm', encode: (v) => fromBool(v as boolean) },
  pinned: { column: 'pinned', encode: (v) => fromBool(v as boolean) },
  hidden: { column: 'hidden', encode: (v) => fromBool(v as boolean) }
}

function requireRow(id: string): ConversationRow {
  const row = selectById().get(id)
  if (!row) throw new AppError('not_found', 'That conversation no longer exists.', id)
  return row
}

function memberIdsOf(conversationId: string): string[] {
  return selectMemberIds()
    .all(conversationId)
    .map((r) => r.bot_id)
}

function writeMembers(conversationId: string, botIds: string[], now: string): void {
  // Dedupe while preserving the caller's order: position drives @mention
  // resolution order and the member avatars in the header.
  const unique = [...new Set(botIds)]
  for (const botId of unique) {
    if (!selectBotIdsExisting().get(botId)) {
      throw new AppError('not_found', 'One of the selected Bots no longer exists.', botId)
    }
  }
  unique.forEach((botId, index) => insertMember().run(conversationId, botId, index, now))

  if (unique.length > 0) {
    const placeholders = unique.map(() => '?').join(',')
    getDb()
      .prepare(`DELETE FROM conversation_members WHERE conversation_id = ? AND bot_id NOT IN (${placeholders})`)
      .run(conversationId, ...unique)
  } else {
    getDb().prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(conversationId)
  }
}

/**
 * The one-line preview the sidebar shows, or null when there are no messages.
 *
 * The newest row's body is legitimately EMPTY in several ordinary cases: a turn
 * stopped before it wrote anything (`JobScheduler` inserts the bot's row at
 * enqueue time and never backfills a body for a cancelled turn), a turn still
 * queued behind the concurrency limit, a turn that finished with tool calls and
 * no prose, an attachment-only message. All of them previewed as '' and the
 * sidebar's falsy check printed "No messages yet" — on a conversation with nine
 * messages, one of them 30 seconds old, which reads as the chat having been
 * wiped. Describe the newest turn from its status instead, so the preview always
 * belongs to the same message as the timestamp and author beside it.
 */
function previewForSummary(row: SummaryRow): string | null {
  if (row.last_message_at === null) return null
  const preview = previewFromMarkdown(row.last_message_body)
  if (preview.length > 0) return preview
  switch (row.last_message_status) {
    case 'cancelled':
    case 'interrupted':
      return 'Stopped'
    case 'error':
      return 'Last run failed'
    case 'queued':
      return 'Queued'
    case 'running':
    case 'streaming':
      return 'Working…'
    default:
      // A complete message with no text. From a Bot that means tool calls and no
      // prose; from the user it means the composer sent attachments only, which
      // is the one empty body it allows.
      return row.last_message_author_type === 'user' ? 'Attachment' : 'No reply text'
  }
}

function toSummary(
  row: SummaryRow,
  memberBotIds: string[],
  running: string[] | undefined,
  queued: string[] | undefined
): ConversationSummary {
  return {
    ...rowToConversation(row, memberBotIds),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: previewForSummary(row),
    // The user's own messages carry no denormalized name; the renderer shows "You".
    lastMessageAuthorName: row.last_message_author_type === 'user' ? null : row.last_message_author_name,
    unreadCount: row.unread_count,
    runningBotIds: running ?? [],
    queuedBotIds: queued ?? []
  }
}

function groupMembers(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of selectAllMembers().all()) {
    const list = map.get(row.conversation_id)
    if (list) list.push(row.bot_id)
    else map.set(row.conversation_id, [row.bot_id])
  }
  return map
}

function groupActiveJobs(): { running: Map<string, string[]>; queued: Map<string, string[]> } {
  const running = new Map<string, string[]>()
  const queued = new Map<string, string[]>()
  for (const row of selectActiveJobs().all()) {
    const target = row.status === 'running' ? running : queued
    const list = target.get(row.conversation_id)
    if (list) {
      if (!list.includes(row.bot_id)) list.push(row.bot_id)
    } else {
      target.set(row.conversation_id, [row.bot_id])
    }
  }
  return { running, queued }
}

export const conversationsRepo = Object.freeze({
  /** Every conversation, hidden ones included — the sidebar owns the Hidden section. */
  listSummaries(): ConversationSummary[] {
    const rows = selectSummaries().all()
    if (rows.length === 0) return []
    const members = groupMembers()
    const { running, queued } = groupActiveJobs()
    return rows.map((row) => toSummary(row, members.get(row.id) ?? [], running.get(row.id), queued.get(row.id)))
  },

  getSummary(id: string): ConversationSummary | null {
    const row = selectSummaryById().get(id)
    if (!row) return null
    const { running, queued } = groupActiveJobs()
    return toSummary(row, memberIdsOf(id), running.get(id), queued.get(id))
  },

  get(id: string): Conversation | null {
    const row = selectById().get(id)
    return row ? rowToConversation(row, memberIdsOf(id)) : null
  },

  findDirectForBot(botId: string): Conversation | null {
    const row = selectDirectForBot().get(botId)
    return row ? rowToConversation(row, memberIdsOf(row.id)) : null
  },

  /**
   * Direct chats are 1:1 with a Bot, so this is idempotent: opening a Bot that
   * was chatted with before must return to that transcript (and un-hide it)
   * rather than start a second, confusingly identical thread.
   */
  createDirect(bot: Bot): Conversation {
    return transaction(() => {
      const now = nowIso()
      const existing = selectDirectForBot().get(bot.id)
      if (existing) {
        if (existing.hidden === 1) unhideConversation().run(now, existing.id)
        return rowToConversation(requireRow(existing.id), memberIdsOf(existing.id))
      }

      const id = newId('conv')
      insertConversation().run({
        id,
        type: 'direct',
        name: bot.name,
        icon: null,
        workspace_directory: null,
        // A direct chat has exactly one possible responder.
        default_responder_bot_id: bot.id,
        skip_everyone_confirm: 0,
        sort_order: selectNextSortOrder().get()?.next ?? 1,
        created_at: now,
        updated_at: now
      })
      writeMembers(id, [bot.id], now)
      return rowToConversation(requireRow(id), [bot.id])
    })
  },

  createGroup(input: CreateGroupInput): Conversation {
    if (input.memberBotIds.length === 0) {
      throw new AppError('invalid_input', 'A group needs at least one Bot.')
    }
    return transaction(() => {
      const now = nowIso()
      const id = newId('conv')
      insertConversation().run({
        id,
        type: 'group',
        name: input.name.trim(),
        icon: input.icon ?? null,
        workspace_directory: input.workspaceDirectory ?? null,
        default_responder_bot_id: null,
        skip_everyone_confirm: 0,
        sort_order: selectNextSortOrder().get()?.next ?? 1,
        created_at: now,
        updated_at: now
      })
      writeMembers(id, input.memberBotIds, now)
      return rowToConversation(requireRow(id), memberIdsOf(id))
    })
  },

  update(id: string, patch: ConversationPatch): Conversation {
    return transaction(() => {
      requireRow(id)
      const now = nowIso()

      const assignments: string[] = []
      const values: unknown[] = []
      for (const [key, value] of Object.entries(patch)) {
        const mapping = UPDATABLE[key]
        if (!mapping || value === undefined) continue
        assignments.push(`${mapping.column} = ?`)
        values.push(bindValue(mapping.encode(value)))
      }

      if (assignments.length > 0) {
        assignments.push('updated_at = ?')
        values.push(now, id)
        getDb()
          .prepare(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`)
          .run(...values)
      }

      if (patch.memberBotIds !== undefined) {
        writeMembers(id, patch.memberBotIds, now)
        touchConversation().run(now, id)
      }

      return rowToConversation(requireRow(id), memberIdsOf(id))
    })
  },

  /** Cascades to members, messages, mentions, attachments, activities and reactions. */
  remove(id: string): void {
    deleteConversation().run(id)
  },

  markRead(id: string): void {
    setLastRead().run(nowIso(), id)
  },

  touch(id: string): void {
    touchConversation().run(nowIso(), id)
  },

  members(id: string): Bot[] {
    return selectMemberBots().all(id).map(rowToBot)
  },

  setMembers(id: string, botIds: string[]): void {
    transaction(() => {
      requireRow(id)
      const now = nowIso()
      writeMembers(id, botIds, now)
      touchConversation().run(now, id)
    })
  },

  /**
   * Used when a Bot is deleted. Membership rows also cascade from the FK, but
   * calling this explicitly keeps the behaviour correct for callers that only
   * want the Bot out of every group (and clears any stale default-responder
   * pointer, which has no FK of its own).
   */
  removeBotFromAll(botId: string): void {
    transaction(() => {
      deleteMembership().run(botId)
      clearDefaultResponderFor().run(nowIso(), botId)
    })
  }
})
