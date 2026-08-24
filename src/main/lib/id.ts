/**
 * Identifier + timestamp helpers.
 *
 * Every row id in the database is `<prefix>_<12 lowercase hex chars>`. The prefix
 * makes ids self-describing in logs and in the diagnostics report (`bot_…`,
 * `conv_…`, `msg_…`), which matters a lot when reading a stream of events by eye.
 * 48 bits of randomness is plenty for a single-user local app: even at a million
 * rows the collision probability stays far below one in a million, and every
 * insert goes through a PRIMARY KEY that would reject a duplicate anyway.
 */
import { randomBytes } from 'node:crypto'

/** Number of random bytes per id — 6 bytes renders as exactly 12 hex chars. */
const ID_BYTES = 6

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_BYTES).toString('hex')}`
}

/**
 * The one and only way this app produces a timestamp. Everything persisted or
 * sent over IPC is an ISO 8601 string in UTC, which is also lexicographically
 * sortable — the message pagination cursor and the `created_at` indexes rely on
 * that property, so never store a locale-formatted date.
 */
export function nowIso(): string {
  return new Date().toISOString()
}
