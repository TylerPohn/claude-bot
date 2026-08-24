/**
 * Full-text search over message bodies (PRD §20.1).
 *
 * The FTS5 index is external-content over `messages`, kept in step by triggers,
 * so search never stores a second copy of the transcript.
 */
import type { SearchResult } from '@shared/types'
import { stmt } from '@main/db/index'
import { log } from '@main/lib/logger'
import { asAccentOrNull, type MessageRow } from '@main/db/rows'
import { sanitizeFtsQuery } from './ftsQuery'

/** Kept on this module's surface: the sanitizer used to live here. */
export { sanitizeFtsQuery }

interface SearchRow extends Pick<MessageRow, 'author_name' | 'author_type' | 'author_accent' | 'created_at'> {
  message_id: string
  conversation_id: string
  conversation_name: string
  conversation_type: string
  snippet: string
}

/**
 * `snippet()` wraps each hit in U+0001 / U+0002 (written as `char(1)`/`char(2)`)
 * instead of `<b>` tags: the renderer splits on those sentinels and builds real
 * elements, so a message containing HTML can never be interpreted as markup by
 * the search UI. bm25 ranks lower-is-better, hence the plain ascending sort.
 */
const searchStmt = stmt<SearchRow>(`
  SELECT
    m.id AS message_id,
    m.conversation_id AS conversation_id,
    m.author_name AS author_name,
    m.author_type AS author_type,
    m.author_accent AS author_accent,
    m.created_at AS created_at,
    c.name AS conversation_name,
    c.type AS conversation_type,
    snippet(messages_fts, 0, char(1), char(2), '…', 14) AS snippet
  FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid
  JOIN conversations c ON c.id = m.conversation_id
  WHERE messages_fts MATCH ?
  ORDER BY bm25(messages_fts), m.created_at DESC
  LIMIT ?`)

export const searchRepo = Object.freeze({
  search(query: string, limit: number): SearchResult[] {
    const match = sanitizeFtsQuery(query)
    if (!match) return []

    let rows: SearchRow[]
    try {
      rows = searchStmt().all(match, Math.max(1, Math.trunc(limit)))
    } catch (e) {
      // FTS5 raises SqliteError for expressions the sanitizer did not anticipate.
      // Search is a convenience surface: degrade to "no results", never crash.
      log.warn('search', 'FTS query failed', { match, error: e instanceof Error ? e.message : String(e) })
      return []
    }

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      conversationName: row.conversation_name,
      conversationType: row.conversation_type === 'direct' ? 'direct' : 'group',
      authorName: row.author_name,
      authorType: row.author_type === 'user' ? 'user' : row.author_type === 'bot' ? 'bot' : 'system',
      authorAccent: asAccentOrNull(row.author_accent),
      snippetHtmlSafe: row.snippet,
      createdAt: row.created_at
    }))
  }
})
