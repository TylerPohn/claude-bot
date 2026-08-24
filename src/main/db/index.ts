/**
 * Database lifecycle and the prepared-statement cache every repository uses.
 *
 * Deliberate constraint: nothing under `src/main/db` may import Electron, so the
 * repositories can be exercised from a plain `node --test` process against a
 * temp-file or in-memory database. `initDatabase()` therefore accepts an explicit
 * path, and only falls back to Electron's userData directory when called with no
 * argument (which is the app-runtime case).
 */
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'
import { runMigrations } from '@main/db/migrate'

/** Filename inside Electron's userData dir. `@main/lib/paths` builds the full path from this. */
export const DATABASE_FILENAME = 'claude-code-bots.db'

let instance: BetterSqlite3.Database | null = null

/**
 * Resolve the default database location without a static `import ... from 'electron'`.
 *
 * A top-level Electron import would make this module — and therefore every
 * repository — unloadable under `node --test`: Node cannot detect named exports on
 * Electron's CommonJS shim, so the import itself throws before any test runs.
 * `createRequire` defers that cost to the one code path that genuinely needs it.
 */
function defaultDatabasePath(): string {
  const require = createRequire(import.meta.url)
  const electron = require('electron') as { app: { getPath(name: string): string } }
  return join(electron.app.getPath('userData'), DATABASE_FILENAME)
}

export function initDatabase(dbPath?: string): BetterSqlite3.Database {
  if (instance && instance.open) return instance

  const file = dbPath ?? defaultDatabasePath()
  if (file !== ':memory:') {
    // First launch: userData exists, but a caller-supplied path may not.
    mkdirSync(dirname(file), { recursive: true })
  }

  let db: BetterSqlite3.Database
  try {
    db = new Database(file)
  } catch (e) {
    throw new AppError(
      'io',
      'Could not open the Claude Code Bots database.',
      `${file}: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  // WAL keeps a streaming write (one UPDATE per token batch) from blocking reads.
  db.pragma('journal_mode = WAL')
  // Off by default in SQLite; every ON DELETE CASCADE in the schema depends on it.
  db.pragma('foreign_keys = ON')
  // A checkpoint or a concurrent reader should make a write wait, never fail outright.
  db.pragma('busy_timeout = 5000')

  runMigrations(db)

  instance = db
  log.info('db', 'database ready', { file, path: db.name })
  return db
}

export function getDb(): BetterSqlite3.Database {
  if (!instance || !instance.open) {
    throw new AppError('internal', 'Database is not initialized.', 'initDatabase() must run before any repository call')
  }
  return instance
}

export function closeDatabase(): void {
  if (!instance) return
  try {
    if (instance.open) {
      // Fold the WAL back into the main file so a backup/export of the .db is complete.
      instance.pragma('wal_checkpoint(TRUNCATE)')
      instance.close()
    }
  } catch (e) {
    log.warn('db', 'error while closing database', e)
  } finally {
    instance = null
  }
}

/**
 * Run `fn` inside a SQLite transaction. Nested calls are safe — better-sqlite3
 * turns an inner transaction into a SAVEPOINT — so repositories can compose
 * without knowing whether a caller already opened one.
 *
 * `fn` must be synchronous: better-sqlite3 commits when the function returns, so
 * a promise would commit an empty transaction immediately.
 */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)()
}

/**
 * Lazily prepare and memoize a statement.
 *
 * Statements cannot be prepared at import time (no database exists yet), and
 * re-preparing on every call would dominate the cost of a hot path like
 * `appendText`. The cached statement is tied to the database instance that
 * produced it, so a `closeDatabase()` + `initDatabase()` cycle in tests
 * transparently re-prepares instead of using a finalized handle.
 */
export function stmt<R = unknown>(sql: string): () => BetterSqlite3.Statement<unknown[], R> {
  let cachedFor: BetterSqlite3.Database | null = null
  let cached: BetterSqlite3.Statement<unknown[], R> | null = null

  return () => {
    const db = getDb()
    if (!cached || cachedFor !== db) {
      cached = db.prepare<unknown[], R>(sql)
      cachedFor = db
    }
    return cached
  }
}

/**
 * Same idea for `... IN (?, ?, ?)` queries, where the SQL text depends on how
 * many ids are being looked up. Memoized per placeholder count so paging the
 * same limit repeatedly reuses one statement.
 */
export function stmtN<R = unknown>(
  build: (placeholders: string) => string
): (count: number) => BetterSqlite3.Statement<unknown[], R> {
  let cachedFor: BetterSqlite3.Database | null = null
  const byCount = new Map<number, BetterSqlite3.Statement<unknown[], R>>()

  return (count: number) => {
    const db = getDb()
    if (cachedFor !== db) {
      byCount.clear()
      cachedFor = db
    }
    let prepared = byCount.get(count)
    if (!prepared) {
      prepared = db.prepare<unknown[], R>(build(new Array(count).fill('?').join(',')))
      byCount.set(count, prepared)
    }
    return prepared
  }
}

/**
 * SQLite's default parameter limit is 32766, but statement text also grows with
 * the id count, so bulk hydration is chunked well below that.
 */
export const ID_CHUNK_SIZE = 400

export function chunk<T>(items: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  if (items.length <= size) return items.length === 0 ? [] : [items.slice()]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
