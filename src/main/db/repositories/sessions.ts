/**
 * Per-(bot, conversation) Claude Code session state.
 *
 * Two independent facts live on this row:
 *
 * - `claude_session_id` is the id `--resume` gets. Verified behaviour: resuming
 *   keeps the same session id rather than forking, so this value is stable for
 *   the lifetime of the pairing until Claude Code forgets it.
 * - `last_seen_message_id` is how far the group context bridge has caught this
 *   Bot up. It is advanced only when a turn completes, so a cancelled turn
 *   re-sends the context it never got to read.
 */
import type { BotConversationSession } from '@shared/types'
import { stmt } from '@main/db/index'
import { log } from '@main/lib/logger'
import { nowIso } from '@main/lib/id'
import { rowToSession, type SessionRow } from '@main/db/rows'

const SESSION_COLUMNS = 'bot_id, conversation_id, claude_session_id, last_seen_message_id, created_at, updated_at'

const selectOne = stmt<SessionRow>(
  `SELECT ${SESSION_COLUMNS} FROM bot_conversation_sessions WHERE bot_id = ? AND conversation_id = ?`
)

const upsertSession = stmt(`
  INSERT INTO bot_conversation_sessions (bot_id, conversation_id, claude_session_id, last_seen_message_id, created_at, updated_at)
  VALUES (?, ?, ?, NULL, ?, ?)
  ON CONFLICT (bot_id, conversation_id)
  DO UPDATE SET claude_session_id = excluded.claude_session_id, updated_at = excluded.updated_at`)

const upsertLastSeen = stmt(`
  INSERT INTO bot_conversation_sessions (bot_id, conversation_id, claude_session_id, last_seen_message_id, created_at, updated_at)
  VALUES (?, ?, NULL, ?, ?, ?)
  ON CONFLICT (bot_id, conversation_id)
  DO UPDATE SET last_seen_message_id = excluded.last_seen_message_id, updated_at = excluded.updated_at`)

/** `last_seen_message_id` carries no foreign key, so `setLastSeen` checks by hand. */
const messageExists = stmt<{ one: number }>('SELECT 1 AS one FROM messages WHERE id = ?')

/**
 * Both columns are `REFERENCES ... ON DELETE CASCADE`, so a write here fails
 * outright if the Bot or the conversation was deleted while a turn was still
 * running. That race is normal — the user hit Delete mid-answer — but it used to
 * surface as a thrown `FOREIGN KEY constraint failed`, which the scheduler
 * reported as a failed turn: the Bot's complete answer was left in the
 * transcript under a red error triangle, and the rest of `#finalize` (body,
 * usage, `status = 'complete'`) never ran.
 *
 * Session state is bookkeeping for a pairing that no longer exists, so dropping
 * the write is the correct outcome. Only the foreign-key case is swallowed;
 * every other SQLite failure still throws, because those are real bugs.
 */
function ignoreIfParentDeleted(what: string, botId: string, conversationId: string, write: () => void): void {
  try {
    write()
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err
    log.warn('db', `skipped ${what}: the Bot or conversation was deleted mid-turn`, {
      botId,
      conversationId
    })
  }
}

export const sessionsRepo = Object.freeze({
  get(botId: string, conversationId: string): BotConversationSession | null {
    const row = selectOne().get(botId, conversationId)
    return row ? rowToSession(row) : null
  },

  upsertSessionId(botId: string, conversationId: string, claudeSessionId: string | null): void {
    const now = nowIso()
    ignoreIfParentDeleted('session id write', botId, conversationId, () => {
      upsertSession().run(botId, conversationId, claudeSessionId, now, now)
    })
  },

  /**
   * Advance the read watermark, refusing any id that no longer names a row.
   *
   * The scheduler captures its delivery plan BEFORE a turn runs and writes the
   * watermark when the turn finishes, so a message deleted (or a whole transcript
   * cleared) while a Bot is answering leaves the plan naming a row that is gone by
   * the time it lands. `last_seen_message_id` has no foreign key, so that stale
   * write stuck — and `since()` cannot resolve the anchor, falls back to "seen
   * nothing", and replays the ENTIRE conversation into that Bot's next prompt, up
   * to the whole group-bridge budget, billed against the user's Claude allowance.
   *
   * Keeping the current value is the right repair, not writing NULL: `messages.remove`
   * has already re-pointed the durable watermark at the deleted row's predecessor,
   * and NULL is itself the "seen nothing" state that causes the same full replay.
   */
  setLastSeen(botId: string, conversationId: string, messageId: string | null): void {
    if (messageId !== null && !messageExists().get(messageId)) {
      log.warn('db', 'refused a read watermark naming a message that no longer exists', {
        botId,
        conversationId,
        messageId
      })
      return
    }
    const now = nowIso()
    ignoreIfParentDeleted('last-seen write', botId, conversationId, () => {
      upsertLastSeen().run(botId, conversationId, messageId, now, now)
    })
  },

  /**
   * Forget the Claude session after a failed `--resume`, so the next turn starts
   * a fresh one and re-sends the profile layer.
   *
   * `last_seen_message_id` is intentionally preserved: the recovery transcript
   * already replays the recent history, and resetting the bridge watermark here
   * would make the next prompt contain the same messages twice.
   */
  clearSession(botId: string, conversationId: string): void {
    const now = nowIso()
    ignoreIfParentDeleted('session clear', botId, conversationId, () => {
      upsertSession().run(botId, conversationId, null, now, now)
    })
  }
})
