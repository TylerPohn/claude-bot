/**
 * Activity repository — the normalized tool timeline attached to a bot message.
 *
 * Activities are created from a `tool_use` block and completed from the matching
 * `tool_result` block, which may arrive many seconds later and always carries the
 * same `tool_use_id`. That id is therefore the join key, not the activity's own id.
 */
import type { Activity } from '@shared/types'
import { stmt, transaction } from '@main/db/index'
import { newId, nowIso } from '@main/lib/id'
import { rowToActivity, type ActivityRow } from '@main/db/rows'

export type CreateActivityInput = Omit<Activity, 'id' | 'startedAt' | 'endedAt' | 'seq'> & {
  startedAt?: string
}

export type FinishActivityPatch = Partial<
  Pick<Activity, 'status' | 'subtitle' | 'detail' | 'addedLines' | 'removedLines'>
>

const ACTIVITY_COLUMNS = `id, message_id, bot_id, type, title, subtitle, detail, tool_name,
  tool_use_id, status, added_lines, removed_lines, started_at, ended_at, seq`

const insertActivity = stmt(`
  INSERT INTO activities (
    id, message_id, bot_id, type, title, subtitle, detail, tool_name, tool_use_id,
    status, added_lines, removed_lines, started_at, ended_at, seq
  ) VALUES (
    @id, @message_id, @bot_id, @type, @title, @subtitle, @detail, @tool_name, @tool_use_id,
    @status, @added_lines, @removed_lines, @started_at, NULL, @seq
  )`)

const selectNextSeq = stmt<{ next: number }>(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM activities WHERE message_id = ?'
)
const selectById = stmt<ActivityRow>(`SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE id = ?`)
/**
 * Newest first: a tool_use_id is unique in practice, but a resumed session that
 * replays a block must update the most recent row rather than an older twin.
 */
const selectByToolUseId = stmt<ActivityRow>(
  `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE tool_use_id = ? ORDER BY started_at DESC, seq DESC LIMIT 1`
)
const selectForMessage = stmt<ActivityRow>(
  `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE message_id = ? ORDER BY seq ASC`
)
const selectOpenForMessage = stmt<ActivityRow>(
  `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE message_id = ? AND status = 'running' ORDER BY seq ASC`
)

const updateActivity = stmt(`
  UPDATE activities
  SET status = ?, subtitle = ?, detail = ?, added_lines = ?, removed_lines = ?, ended_at = ?
  WHERE id = ?`)

const closeOpenActivity = stmt(`
  UPDATE activities SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'running'`)

export const activitiesRepo = Object.freeze({
  create(input: CreateActivityInput): Activity {
    return transaction(() => {
      const id = newId('act')
      insertActivity().run({
        id,
        message_id: input.messageId,
        bot_id: input.botId ?? null,
        type: input.type,
        title: input.title,
        subtitle: input.subtitle ?? null,
        detail: input.detail ?? null,
        tool_name: input.toolName ?? null,
        tool_use_id: input.toolUseId ?? null,
        status: input.status,
        added_lines: input.addedLines ?? null,
        removed_lines: input.removedLines ?? null,
        started_at: input.startedAt ?? nowIso(),
        seq: selectNextSeq().get(input.messageId)?.next ?? 1
      })
      return rowToActivity(selectById().get(id)!)
    })
  },

  /**
   * Complete a running activity. Returns null when the tool result refers to an
   * activity we never recorded — which happens legitimately for tool calls that
   * were already in flight when a session was resumed, so it must not throw.
   *
   * The patch is merged in JavaScript because `undefined` (leave alone) and
   * `null` (clear) are both meaningful, and SQL has no way to express that in a
   * single fixed statement.
   */
  finish(toolUseId: string, patch: FinishActivityPatch): Activity | null {
    return transaction(() => {
      const row = selectByToolUseId().get(toolUseId)
      if (!row) return null

      const next = {
        status: patch.status ?? row.status,
        subtitle: 'subtitle' in patch ? patch.subtitle ?? null : row.subtitle,
        detail: 'detail' in patch ? patch.detail ?? null : row.detail,
        addedLines: 'addedLines' in patch ? patch.addedLines ?? null : row.added_lines,
        removedLines: 'removedLines' in patch ? patch.removedLines ?? null : row.removed_lines
      }

      updateActivity().run(
        next.status,
        next.subtitle,
        next.detail,
        next.addedLines,
        next.removedLines,
        // A finished activity always gets an end time; the UI renders its duration.
        row.ended_at ?? nowIso(),
        row.id
      )
      return rowToActivity(selectById().get(row.id)!)
    })
  },

  /**
   * Close every activity of a message that is still `running`, and return the
   * rows that changed so the caller can push them to the renderer.
   *
   * A `tool_end` is the only thing that ever finished an activity, so a turn that
   * was stopped, errored or died with the app left its in-flight tool call
   * `status:'running', ended_at:null` FOREVER. The transcript then hid it —
   * `ActivityStrip` correctly filters running rows out of the finished summary,
   * because while the turn is live the working indicator owns them — so a `Bash`
   * or `Edit` that really did touch the user's disk vanished from the record, on
   * a message whose own footer says actions may already have completed.
   *
   * The row is closed as `cancelled`, not `error`: we never saw a result, so the
   * tool did not fail — we stopped watching. The distinction is visible, since
   * `error` rows are drawn red, labelled "failed" and counted in the failure
   * total. `cancelled` must stay in ACTIVITY_STATUSES (db/rows.ts) or
   * `rowToActivity` coerces it back to 'running' on read and this fix silently
   * reverts on the next reload.
   */
  abandonOpen(messageId: string): Activity[] {
    return transaction(() => {
      const open = selectOpenForMessage().all(messageId)
      if (open.length === 0) return []
      const endedAt = nowIso()
      const closed: Activity[] = []
      for (const row of open) {
        closeOpenActivity().run(endedAt, row.id)
        closed.push(rowToActivity(selectById().get(row.id)!))
      }
      return closed
    })
  },

  listForMessage(messageId: string): Activity[] {
    return selectForMessage().all(messageId).map(rowToActivity)
  }
})
