/**
 * Message repository — the hot path of the whole app.
 *
 * Two design points matter here:
 *
 * 1. Streaming appends never read the body back into JavaScript. A single turn
 *    can emit thousands of deltas; `body = body || ?` keeps each one O(delta)
 *    on the JS side instead of O(body).
 * 2. Pagination is ordered by the composite `(created_at, seq)`. `created_at` is
 *    millisecond ISO text and several messages of one turn routinely share a
 *    millisecond, so a timestamp alone is not a stable cursor — it either skips
 *    or repeats rows at a page boundary.
 */
import type {
  Attachment,
  AuthorType,
  Bot,
  Message,
  MessageMention,
  MessageStatus,
  MessageUsage,
  SystemMessageKind
} from '@shared/types'
import type { AttachmentInput } from '@shared/schemas'
import { chunk, getDb, stmt, stmtN, transaction } from '@main/db/index'
import { AppError } from '@main/lib/errors'
import { newId, nowIso } from '@main/lib/id'
import { log } from '@main/lib/logger'
import {
  fromBool,
  rowToActivity,
  rowToAttachment,
  rowToMention,
  rowToMessage,
  rowToReaction,
  type ActivityRow,
  type AttachmentRow,
  type MentionRow,
  type MessageRecord,
  type MessageRelations,
  type MessageRow,
  type ReactionRow
} from '@main/db/rows'

/** Attachments may arrive already known-missing (the file was moved before sending). */
export type MessageAttachmentInput = AttachmentInput & { missing?: boolean }

export interface CreateMessageInput {
  conversationId: string
  authorType: AuthorType
  /** Source of the denormalized author identity. Null for user/system messages. */
  authorBot?: Bot | null
  bodyMarkdown?: string
  status?: MessageStatus
  systemKind?: SystemMessageKind | null
  replyToMessageId?: string | null
  handoffFromBotId?: string | null
  jobId?: string | null
  mentions?: MessageMention[]
  attachments?: MessageAttachmentInput[]
}

export interface MessagePageResult {
  messages: Message[]
  hasMore: boolean
  nextCursor: string | null
}

const MESSAGE_COLUMNS = `id, conversation_id, author_type, author_bot_id, author_name,
  author_avatar_type, author_avatar_value, author_accent, body_markdown, thinking_markdown,
  reply_to_message_id, status, system_kind, handoff_from_bot_id, job_id, error_text,
  usage_json, seq, created_at, updated_at`

/**
 * Statuses that mean "this row is still being written". They are excluded from
 * the context bridge: half a sentence is worse than no sentence for another Bot.
 */
const IN_FLIGHT_STATUSES = "('streaming', 'running', 'queued')"

const insertMessage = stmt(`
  INSERT INTO messages (
    id, conversation_id, author_type, author_bot_id, author_name, author_avatar_type,
    author_avatar_value, author_accent, body_markdown, thinking_markdown, reply_to_message_id,
    status, system_kind, handoff_from_bot_id, job_id, error_text, usage_json, seq,
    created_at, updated_at
  ) VALUES (
    @id, @conversation_id, @author_type, @author_bot_id, @author_name, @author_avatar_type,
    @author_avatar_value, @author_accent, @body_markdown, '', @reply_to_message_id,
    @status, @system_kind, @handoff_from_bot_id, @job_id, NULL, NULL, @seq,
    @created_at, @updated_at
  )`)

const insertMention = stmt(`
  INSERT INTO message_mentions (message_id, bot_id, display, everyone, start_index, end_index)
  VALUES (?, ?, ?, ?, ?, ?)`)

const insertAttachment = stmt(`
  INSERT INTO attachments (id, message_id, path, name, kind, size_bytes, mime_type, missing, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)

const selectNextSeq = stmt<{ next: number }>(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?'
)
const selectById = stmt<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`)
const selectPageHead = stmt<MessageRow>(`
  SELECT ${MESSAGE_COLUMNS} FROM messages
  WHERE conversation_id = ?
  ORDER BY created_at DESC, seq DESC
  LIMIT ?`)
const selectPageBefore = stmt<MessageRow>(`
  SELECT ${MESSAGE_COLUMNS} FROM messages
  WHERE conversation_id = ?
    AND (created_at < ? OR (created_at = ? AND seq < ?))
  ORDER BY created_at DESC, seq DESC
  LIMIT ?`)
const selectSinceAll = stmt<MessageRow>(`
  SELECT ${MESSAGE_COLUMNS} FROM messages
  WHERE conversation_id = ? AND status NOT IN ${IN_FLIGHT_STATUSES}
  ORDER BY created_at ASC, seq ASC`)
const selectSinceAfter = stmt<MessageRow>(`
  SELECT ${MESSAGE_COLUMNS} FROM messages
  WHERE conversation_id = ?
    AND (created_at > ? OR (created_at = ? AND seq > ?))
    AND status NOT IN ${IN_FLIGHT_STATUSES}
  ORDER BY created_at ASC, seq ASC`)
const selectLastId = stmt<{ id: string }>(
  'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1'
)
const selectCount = stmt<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')

const appendBody = stmt(
  'UPDATE messages SET body_markdown = body_markdown || ?, updated_at = ? WHERE id = ?'
)
const appendThinkingBody = stmt(
  'UPDATE messages SET thinking_markdown = thinking_markdown || ?, updated_at = ? WHERE id = ?'
)
const updateBody = stmt('UPDATE messages SET body_markdown = ?, updated_at = ? WHERE id = ?')
const updateStatus = stmt('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?')
const updateStatusAndError = stmt(
  'UPDATE messages SET status = ?, error_text = ?, updated_at = ? WHERE id = ?'
)
const updateUsage = stmt('UPDATE messages SET usage_json = ?, updated_at = ? WHERE id = ?')
const updateCreatedAt = stmt('UPDATE messages SET created_at = ?, updated_at = ? WHERE id = ?')
const deleteMessage = stmt('DELETE FROM messages WHERE id = ?')
const deleteConversationMessages = stmt('DELETE FROM messages WHERE conversation_id = ?')

/**
 * Re-point every Bot whose read watermark is the row about to be deleted at that
 * row's predecessor.
 *
 * `bot_conversation_sessions.last_seen_message_id` carries no foreign key, and
 * `since()` resolves it by id: once the row was gone the anchor stopped
 * resolving and `since()` fell back to "seen nothing", handing that Bot the
 * ENTIRE conversation again — up to the whole 24k-char group bridge budget, per
 * Bot, with old already-answered instructions re-presented under "Messages since
 * you last participated". Deleting your own last message (the ⋯ menu, right
 * there on the row) is exactly the trigger, because the watermark is normally
 * the triggering user message.
 *
 * The predecessor preserves the real meaning — that row and everything before it
 * were seen, everything after is still unseen — and yields NULL only when the
 * deleted row was the conversation's first, where NULL is the correct answer.
 * Nulling the watermark outright would NOT do: NULL is the "seen nothing" state
 * and replays exactly the same backlog.
 *
 * In-flight rows are skipped when choosing the predecessor. A watermark may
 * never land on a message that is still being written, because `since()` hides
 * it now and would hide it forever once the cursor sat past it (./delivery.ts).
 * The scheduler's read barrier already makes that unreachable here; the filter
 * costs nothing and means a future caller cannot reintroduce it.
 */
const repointLastSeen = stmt(`
  UPDATE bot_conversation_sessions
     SET last_seen_message_id = (
           SELECT id FROM messages
            WHERE conversation_id = @conversation_id
              AND (created_at < @created_at OR (created_at = @created_at AND seq < @seq))
              AND status NOT IN ${IN_FLIGHT_STATUSES}
            ORDER BY created_at DESC, seq DESC
            LIMIT 1),
         updated_at = @now
   WHERE conversation_id = @conversation_id AND last_seen_message_id = @id`)

/** Nothing survives a clear, so "seen nothing" is the honest watermark. */
const clearLastSeen = stmt(
  'UPDATE bot_conversation_sessions SET last_seen_message_id = NULL, updated_at = ? WHERE conversation_id = ?'
)

const deleteReaction = stmt('DELETE FROM reactions WHERE message_id = ? AND emoji = ?')
const insertReaction = stmt('INSERT INTO reactions (message_id, emoji, created_at) VALUES (?, ?, ?)')

const selectMentionsFor = stmtN<MentionRow>(
  (p) => `SELECT id, message_id, bot_id, display, everyone, start_index, end_index
          FROM message_mentions WHERE message_id IN (${p}) ORDER BY start_index ASC`
)
const selectAttachmentsFor = stmtN<AttachmentRow>(
  (p) => `SELECT id, message_id, path, name, kind, size_bytes, mime_type, missing, created_at
          FROM attachments WHERE message_id IN (${p}) ORDER BY created_at ASC, id ASC`
)
const selectActivitiesFor = stmtN<ActivityRow>(
  (p) => `SELECT id, message_id, bot_id, type, title, subtitle, detail, tool_name, tool_use_id,
                 status, added_lines, removed_lines, started_at, ended_at, seq
          FROM activities WHERE message_id IN (${p}) ORDER BY seq ASC`
)
const selectReactionsFor = stmtN<ReactionRow>(
  (p) => `SELECT message_id, emoji, created_at FROM reactions
          WHERE message_id IN (${p}) ORDER BY created_at ASC`
)

/* ------------------------------------------------------------------ *
 * Cursor
 * ------------------------------------------------------------------ */

/**
 * The page cursor is `<created_at>|<seq>`: an ISO timestamp plus the message's
 * per-conversation sequence number, which together are unique and ordered.
 *
 * A bare ISO string (no `|`) is still accepted — it is exactly the "exclusive on
 * created_at" contract from the IPC schema — and decodes to seq 0, which makes
 * the composite comparison collapse back to `created_at < cursor`.
 */
function encodeCursor(row: MessageRow): string {
  return `${row.created_at}|${row.seq}`
}

function decodeCursor(cursor: string): { createdAt: string; seq: number } {
  const pipe = cursor.lastIndexOf('|')
  if (pipe === -1) return { createdAt: cursor, seq: 0 }
  const seq = Number.parseInt(cursor.slice(pipe + 1), 10)
  return { createdAt: cursor.slice(0, pipe), seq: Number.isFinite(seq) ? seq : 0 }
}

/* ------------------------------------------------------------------ *
 * Hydration
 * ------------------------------------------------------------------ */

function groupBy<T extends { message_id: string }, R>(rows: T[], map: (row: T) => R): Map<string, R[]> {
  const out = new Map<string, R[]>()
  for (const row of rows) {
    const list = out.get(row.message_id)
    if (list) list.push(map(row))
    else out.set(row.message_id, [map(row)])
  }
  return out
}

/**
 * Load mentions, attachments, activities and reactions for a batch of messages
 * in four queries total rather than four per message.
 */
function hydrate(rows: MessageRow[]): MessageRecord[] {
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const mentions = new Map<string, MessageMention[]>()
  const attachments = new Map<string, Attachment[]>()
  const activities = new Map<string, ReturnType<typeof rowToActivity>[]>()
  const reactions = new Map<string, ReturnType<typeof rowToReaction>[]>()

  for (const part of chunk(ids)) {
    const n = part.length
    for (const [key, value] of groupBy(selectMentionsFor(n).all(...part), rowToMention)) mentions.set(key, value)
    for (const [key, value] of groupBy(selectAttachmentsFor(n).all(...part), rowToAttachment)) {
      attachments.set(key, value)
    }
    for (const [key, value] of groupBy(selectActivitiesFor(n).all(...part), rowToActivity)) {
      activities.set(key, value)
    }
    for (const [key, value] of groupBy(selectReactionsFor(n).all(...part), rowToReaction)) reactions.set(key, value)
  }

  return rows.map((row) => {
    const relations: MessageRelations = {
      mentions: mentions.get(row.id) ?? [],
      attachments: attachments.get(row.id) ?? [],
      activities: activities.get(row.id) ?? [],
      reactions: reactions.get(row.id) ?? []
    }
    return rowToMessage(row, relations)
  })
}

function requireRow(id: string): MessageRow {
  const row = selectById().get(id)
  if (!row) throw new AppError('not_found', 'That message no longer exists.', id)
  return row
}

function hydrateOne(id: string): MessageRecord {
  const [message] = hydrate([requireRow(id)])
  // `hydrate` returns exactly one record for exactly one row.
  return message as MessageRecord
}

export const messagesRepo = Object.freeze({
  /**
   * `seq` is assigned inside the transaction that inserts the row, so two turns
   * finishing at the same instant cannot land on the same sequence number.
   */
  create(input: CreateMessageInput): MessageRecord {
    return transaction(() => {
      const now = nowIso()
      const id = newId('msg')
      const bot = input.authorBot ?? null

      insertMessage().run({
        id,
        conversation_id: input.conversationId,
        author_type: input.authorType,
        author_bot_id: bot?.id ?? null,
        // Denormalized on purpose: renaming or deleting the Bot must not rewrite history.
        author_name: bot?.name ?? null,
        author_avatar_type: bot?.avatarType ?? null,
        author_avatar_value: bot?.avatarValue ?? null,
        author_accent: bot?.accent ?? null,
        body_markdown: input.bodyMarkdown ?? '',
        reply_to_message_id: input.replyToMessageId ?? null,
        status: input.status ?? 'complete',
        system_kind: input.systemKind ?? null,
        handoff_from_bot_id: input.handoffFromBotId ?? null,
        job_id: input.jobId ?? null,
        seq: selectNextSeq().get(input.conversationId)?.next ?? 1,
        created_at: now,
        updated_at: now
      })

      for (const mention of input.mentions ?? []) {
        insertMention().run(
          id,
          mention.botId ?? null,
          mention.display,
          fromBool(mention.everyone),
          mention.startIndex,
          mention.endIndex
        )
      }

      for (const attachment of input.attachments ?? []) {
        insertAttachment().run(
          newId('att'),
          id,
          attachment.path,
          attachment.name,
          attachment.kind ?? 'file',
          attachment.sizeBytes ?? null,
          attachment.mimeType ?? null,
          fromBool(attachment.missing ?? false),
          now
        )
      }

      return hydrateOne(id)
    })
  },

  get(id: string): Message | null {
    const row = selectById().get(id)
    return row ? hydrate([row])[0] ?? null : null
  },

  /**
   * One page of transcript, returned oldest-first for direct rendering.
   *
   * `before` is an exclusive cursor (see `encodeCursor`); pass the previous
   * result's `nextCursor` to walk backwards through history.
   */
  page(conversationId: string, before: string | null, limit: number): MessagePageResult {
    const size = Math.max(1, Math.trunc(limit))
    // Over-fetch by one: the extra row is the cheapest possible `hasMore` probe.
    const rows = before
      ? (() => {
          const { createdAt, seq } = decodeCursor(before)
          return selectPageBefore().all(conversationId, createdAt, createdAt, seq, size + 1)
        })()
      : selectPageHead().all(conversationId, size + 1)

    const hasMore = rows.length > size
    const pageRows = hasMore ? rows.slice(0, size) : rows
    // The query walks backwards from the newest message; the UI renders forwards.
    pageRows.reverse()

    return {
      messages: hydrate(pageRows),
      hasMore,
      nextCursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[0]!) : null
    }
  },

  /**
   * Hot path: append without ever loading the existing body into JS.
   *
   * Note for callers: the `messages_au` trigger re-indexes the row in FTS on
   * every body write, so deltas should be batched (the scheduler coalesces to
   * roughly one write per animation frame) rather than written per token.
   */
  appendText(id: string, delta: string): void {
    if (delta.length === 0) return
    appendBody().run(delta, nowIso(), id)
  },

  appendThinking(id: string, delta: string): void {
    if (delta.length === 0) return
    appendThinkingBody().run(delta, nowIso(), id)
  },

  setBody(id: string, body: string): void {
    updateBody().run(body, nowIso(), id)
  },

  setStatus(id: string, status: MessageStatus, errorText?: string | null): void {
    // `undefined` leaves any existing error text alone; `null` clears it.
    if (errorText === undefined) updateStatus().run(status, nowIso(), id)
    else updateStatusAndError().run(status, errorText, nowIso(), id)
  },

  setUsage(id: string, usage: MessageUsage | null): void {
    updateUsage().run(usage ? JSON.stringify(usage) : null, nowIso(), id)
  },

  /**
   * Move a row's position in the transcript.
   *
   * `created_at` is the primary sort key everywhere (see the header note on the
   * composite cursor), so this is a REORDER, not a metadata tweak — use it only
   * on a row that is still in flight, where no pagination cursor can point past
   * it yet. The one caller is session recovery (JobScheduler, PRD §37): the
   * reply row is created at enqueue time, so the "started a fresh session"
   * notice written mid-turn would otherwise always sort below the answer it
   * explains, and `seq` cannot break the tie because it never reaches the
   * renderer.
   */
  setCreatedAt(id: string, createdAt: string): void {
    updateCreatedAt().run(createdAt, nowIso(), id)
  },

  /**
   * The watermark repair lives here rather than in the IPC handler so every
   * caller is covered, and the row is looked up here rather than taken from the
   * caller so none of them can pass a stale one.
   */
  remove(id: string): void {
    transaction(() => {
      const row = selectById().get(id)
      if (!row) return
      repointLastSeen().run({
        id,
        conversation_id: row.conversation_id,
        created_at: row.created_at,
        seq: row.seq,
        now: nowIso()
      })
      deleteMessage().run(id)
    })
  },

  /**
   * Everything the given Bot has not seen yet, oldest first.
   *
   * Feeds the group context bridge, so in-flight placeholders are skipped: their
   * body is a partial sentence. An unknown `afterMessageId` is treated as "seen
   * nothing", which over-includes rather than silently dropping context — but
   * `remove` now re-points watermarks off a row it deletes, so reaching that
   * branch means something wrote a watermark we cannot resolve. Say so: the
   * fallback is a whole-conversation replay billed against the user's allowance.
   */
  since(conversationId: string, afterMessageId: string | null, excludeIds: string[] = []): Message[] {
    const anchor = afterMessageId ? selectById().get(afterMessageId) : null
    if (afterMessageId && !anchor) {
      log.warn('db', 'read watermark points at a message that no longer exists', {
        conversationId,
        afterMessageId
      })
    }
    const rows = anchor
      ? selectSinceAfter().all(conversationId, anchor.created_at, anchor.created_at, anchor.seq)
      : selectSinceAll().all(conversationId)

    if (excludeIds.length === 0) return hydrate(rows)
    const excluded = new Set(excludeIds)
    return hydrate(rows.filter((row) => !excluded.has(row.id)))
  },

  lastMessageId(conversationId: string): string | null {
    return selectLastId().get(conversationId)?.id ?? null
  },

  clearConversation(conversationId: string): void {
    transaction(() => {
      // Every watermark in this conversation names a row that is about to stop
      // existing; see `repointLastSeen` for what a dangling one costs.
      clearLastSeen().run(nowIso(), conversationId)
      // Mentions, attachments, activities and reactions cascade; the FTS delete
      // trigger keeps the search index in step.
      deleteConversationMessages().run(conversationId)
    })
  },

  /**
   * Single-user app: a reaction either exists (it is the user's) or it does not,
   * so toggling is an insert-or-delete with no per-user bookkeeping.
   */
  toggleReaction(messageId: string, emoji: string): Message {
    return transaction(() => {
      requireRow(messageId)
      const removed = deleteReaction().run(messageId, emoji).changes
      if (removed === 0) insertReaction().run(messageId, emoji, nowIso())
      return hydrateOne(messageId)
    })
  },

  countForConversation(conversationId: string): number {
    return selectCount().get(conversationId)?.n ?? 0
  }
})

/** Exposed for the export service, which streams a whole transcript to markdown. */
export function allMessagesForConversation(conversationId: string): Message[] {
  const rows = getDb()
    .prepare<unknown[], MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC`
    )
    .all(conversationId)
  return hydrate(rows)
}
