/**
 * User text -> FTS5 MATCH expression.
 *
 * Split out of `search.ts` so it can be unit-tested on its own: `search.ts`
 * imports the database and the logger, neither of which loads under the plain
 * `node --test` runner the suite uses.
 */

/**
 * The only character that must be removed.
 *
 * Every token below is wrapped in double quotes, and FTS5 re-tokenizes the text
 * *inside* a quoted phrase — so `(`, `*`, `^`, `:` and `-` are already inert
 * there and need no stripping. A `"` is different: it would terminate the phrase
 * early and let the rest of the token be read as query syntax.
 *
 * This used to strip `["*^:()\-]` and join the halves back together, which
 * silently broke every hyphenated term: `electron-builder` became the single
 * token `electronbuilder`, and the index holds `electron` and `builder`, so the
 * search returned nothing at all. Deleting characters from inside a token is
 * never right here — a quote becomes a separator, everything else stays.
 */
const QUOTE_CHAR = /"/g

/** Control characters, including the sentinels `snippet()` uses to mark matches. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** A query with more terms than this is a paste accident, not a search. */
const MAX_TOKENS = 24

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression.
 *
 * Every token is double-quoted, which makes it a literal phrase and neutralizes
 * FTS5 syntax without mangling the term. The final token gets a `*` so results
 * update usefully while the user is still typing the last word.
 *
 * `auth bug`        -> `"auth" "bug"*`
 * `electron-builder` -> `"electron-builder"*`   (matches the indexed pair)
 *
 * Bare `AND`/`OR`/`NOT`/`NEAR` are deliberately NOT filtered: quoting already
 * demotes them to ordinary terms, and dropping them only lost real hits.
 *
 * Returns null when nothing searchable survives, in which case the caller must
 * not run a query at all — an empty MATCH is a syntax error in FTS5.
 */
export function sanitizeFtsQuery(query: string): string | null {
  const cleaned = query.replace(CONTROL_CHARS, '').replace(QUOTE_CHAR, ' ')

  const tokens: string[] = []
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length === 0) continue
    tokens.push(raw)
    if (tokens.length >= MAX_TOKENS) break
  }

  if (tokens.length === 0) return null

  const last = tokens.length - 1
  return tokens.map((token, i) => (i === last ? `"${token}"*` : `"${token}"`)).join(' ')
}
