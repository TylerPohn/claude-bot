/**
 * Bot repository.
 *
 * Bots are the durable identity in this app: a message keeps a denormalized copy
 * of the author's name, avatar and accent precisely so that renaming or deleting
 * a Bot never rewrites history (PRD §21).
 */
import type { Bot, BotDraft, BotPatch } from '@shared/types'
import { getDb, stmt, transaction } from '@main/db/index'
import { AppError } from '@main/lib/errors'
import { newId, nowIso } from '@main/lib/id'
import { bindValue, fromBool, rowToBot, type BotRow } from '@main/db/rows'

/** Longest name we will generate. Mirrors `botDraftSchema.name.max(40)`. */
const MAX_NAME_LENGTH = 40

const BOT_COLUMNS = `id, name, title, description, avatar_type, avatar_value, accent,
  default_working_directory, model, permission_mode, allowed_tools, disallowed_tools,
  pinned, hidden, archived_at, sort_order, created_at, updated_at`

/**
 * Sidebar order: pinned first, then the user's manual order, then alphabetically.
 * `COLLATE NOCASE` keeps "atlas" next to "Atlas" instead of after "Zed".
 */
const ORDER_BY = 'ORDER BY pinned DESC, sort_order ASC, name COLLATE NOCASE ASC'

const selectAll = stmt<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots ${ORDER_BY}`)
const selectVisible = stmt<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots WHERE hidden = 0 ${ORDER_BY}`)
const selectById = stmt<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`)
const selectByName = stmt<BotRow>(`SELECT ${BOT_COLUMNS} FROM bots WHERE name = ? COLLATE NOCASE LIMIT 1`)
const selectNames = stmt<{ name: string }>('SELECT name FROM bots')
const selectCount = stmt<{ n: number }>('SELECT COUNT(*) AS n FROM bots')
const selectNextSortOrder = stmt<{ next: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM bots')

const insertBot = stmt(`
  INSERT INTO bots (
    id, name, title, description, avatar_type, avatar_value, accent,
    default_working_directory, model, permission_mode, allowed_tools, disallowed_tools,
    pinned, hidden, archived_at, sort_order, created_at, updated_at
  ) VALUES (
    @id, @name, @title, @description, @avatar_type, @avatar_value, @accent,
    @default_working_directory, @model, @permission_mode, @allowed_tools, @disallowed_tools,
    @pinned, @hidden, @archived_at, @sort_order, @created_at, @updated_at
  )`)

const deleteBot = stmt('DELETE FROM bots WHERE id = ?')
const clearDefaultResponder = stmt(
  'UPDATE conversations SET default_responder_bot_id = NULL, updated_at = ? WHERE default_responder_bot_id = ?'
)

/**
 * Direct conversations this Bot belongs to, with the two counts that decide what
 * happens to them when the Bot is deleted.
 */
const selectDirectConversations = stmt<{ id: string; member_count: number; message_count: number }>(`
  SELECT c.id AS id,
    (SELECT COUNT(*) FROM conversation_members cm2 WHERE cm2.conversation_id = c.id) AS member_count,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
  FROM conversations c
  JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.bot_id = ?
  WHERE c.type = 'direct'`)

const deleteConversation = stmt('DELETE FROM conversations WHERE id = ?')
const hideConversation = stmt('UPDATE conversations SET hidden = 1, updated_at = ? WHERE id = ?')

/** patch key -> column name + how the value is encoded for SQLite. */
const UPDATABLE: Record<string, { column: string; encode: (v: unknown) => unknown }> = {
  name: { column: 'name', encode: (v) => v },
  title: { column: 'title', encode: (v) => v ?? null },
  description: { column: 'description', encode: (v) => v ?? '' },
  avatarType: { column: 'avatar_type', encode: (v) => v },
  avatarValue: { column: 'avatar_value', encode: (v) => v },
  accent: { column: 'accent', encode: (v) => v },
  defaultWorkingDirectory: { column: 'default_working_directory', encode: (v) => v ?? null },
  model: { column: 'model', encode: (v) => v },
  permissionMode: { column: 'permission_mode', encode: (v) => v },
  allowedTools: { column: 'allowed_tools', encode: (v) => JSON.stringify(v ?? []) },
  disallowedTools: { column: 'disallowed_tools', encode: (v) => JSON.stringify(v ?? []) },
  pinned: { column: 'pinned', encode: (v) => fromBool(v as boolean) },
  hidden: { column: 'hidden', encode: (v) => fromBool(v as boolean) }
}

function requireRow(id: string): BotRow {
  const row = selectById().get(id)
  if (!row) throw new AppError('not_found', 'That Bot no longer exists.', id)
  return row
}

/**
 * "Atlas" -> "Atlas copy" -> "Atlas copy 2" -> …
 *
 * Comparison is case-insensitive because `@mention` resolution is: two Bots whose
 * names differ only in case would be indistinguishable in the composer.
 */
function nextCopyName(sourceName: string): string {
  const taken = new Set(selectNames().all().map((r) => r.name.trim().toLowerCase()))

  const suffix = ' copy'
  const base = sourceName.trim().slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length - 3)) + suffix

  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // Astronomically unlikely; fall back to something guaranteed unique.
  return `${base} ${Date.now()}`
}

export const botsRepo = Object.freeze({
  list(includeHidden = false): Bot[] {
    const rows = includeHidden ? selectAll().all() : selectVisible().all()
    return rows.map(rowToBot)
  },

  get(id: string): Bot | null {
    const row = selectById().get(id)
    return row ? rowToBot(row) : null
  },

  /** Returns found bots in the order the ids were given; unknown ids are skipped. */
  getMany(ids: string[]): Bot[] {
    if (ids.length === 0) return []
    const byId = new Map<string, Bot>()
    const select = selectById()
    for (const id of ids) {
      if (byId.has(id)) continue
      const row = select.get(id)
      if (row) byId.set(id, rowToBot(row))
    }
    return ids.map((id) => byId.get(id)).filter((b): b is Bot => b !== undefined)
  },

  findByName(name: string): Bot | null {
    const row = selectByName().get(name.trim())
    return row ? rowToBot(row) : null
  },

  create(input: BotDraft): Bot {
    const now = nowIso()
    const id = newId('bot')
    insertBot().run({
      id,
      name: input.name.trim(),
      title: input.title ?? null,
      description: input.description ?? '',
      // Defaults mirror `botDraftSchema` and the column defaults: the flat
      // shape avatar is the product's signature look, not an emoji.
      avatar_type: input.avatarType ?? 'shape',
      avatar_value: input.avatarValue ?? 'circle',
      accent: input.accent ?? 'violet',
      default_working_directory: input.defaultWorkingDirectory ?? null,
      model: input.model ?? 'default',
      permission_mode: input.permissionMode ?? 'default',
      allowed_tools: JSON.stringify(input.allowedTools ?? []),
      disallowed_tools: JSON.stringify(input.disallowedTools ?? []),
      pinned: 0,
      hidden: 0,
      archived_at: null,
      sort_order: selectNextSortOrder().get()?.next ?? 1,
      created_at: now,
      updated_at: now
    })
    return rowToBot(requireRow(id))
  },

  update(id: string, patch: BotPatch): Bot {
    requireRow(id)

    const assignments: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const mapping = UPDATABLE[key]
      // `undefined` means "not part of this patch"; `null` is a real value.
      if (!mapping || value === undefined) continue
      assignments.push(`${mapping.column} = ?`)
      values.push(bindValue(mapping.encode(value)))
    }

    if (assignments.length > 0) {
      assignments.push('updated_at = ?')
      values.push(nowIso())
      values.push(id)
      getDb()
        .prepare(`UPDATE bots SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values)
    }

    return rowToBot(requireRow(id))
  },

  /**
   * Copies profile, avatar, model, permissions, tools and workspace — never
   * sessions or history (PRD §21). The copy starts unpinned and visible.
   */
  duplicate(id: string): Bot {
    return transaction(() => {
      const source = rowToBot(requireRow(id))
      return botsRepo.create({
        name: nextCopyName(source.name),
        title: source.title,
        description: source.description,
        avatarType: source.avatarType,
        avatarValue: source.avatarValue,
        accent: source.accent,
        defaultWorkingDirectory: source.defaultWorkingDirectory,
        model: source.model,
        permissionMode: source.permissionMode,
        allowedTools: source.allowedTools,
        disallowedTools: source.disallowedTools
      })
    })
  },

  /**
   * Delete a Bot without losing anything it said.
   *
   * `conversation_members` and `bot_conversation_sessions` cascade away with the
   * row; `messages` do not reference `bots` at all, which is why the author
   * fields are denormalized. A direct chat that only this Bot belonged to is
   * deleted when it is empty (nothing of value to keep) and hidden otherwise, so
   * the transcript stays reachable from the sidebar's Hidden section.
   *
   * The return value is not decoration: the caller has to tell the renderer which
   * conversations *disappeared* as opposed to merely changing, and it cannot work
   * that out afterwards from a summary that is already gone. Emitting only
   * `conversation:updated` for the survivors left the deleted direct chat in the
   * sidebar as a ghost row that opened as a fully working-looking conversation
   * and failed only when the user pressed send.
   */
  remove(id: string): { deletedConversationIds: string[]; hiddenConversationIds: string[] } {
    return transaction(() => {
      const now = nowIso()
      const directs = selectDirectConversations().all(id)
      const deletedConversationIds: string[] = []
      const hiddenConversationIds: string[] = []

      clearDefaultResponder().run(now, id)
      deleteBot().run(id)

      for (const conversation of directs) {
        if (conversation.member_count !== 1) continue
        if (conversation.message_count === 0) {
          deleteConversation().run(conversation.id)
          deletedConversationIds.push(conversation.id)
        } else {
          hideConversation().run(now, conversation.id)
          hiddenConversationIds.push(conversation.id)
        }
      }
      return { deletedConversationIds, hiddenConversationIds }
    })
  },

  count(): number {
    return selectCount().get()?.n ?? 0
  }
})
