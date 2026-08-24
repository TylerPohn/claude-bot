/**
 * Migration runner.
 *
 * `PRAGMA user_version` is a 32-bit integer stored in the database header, which
 * makes it the cheapest possible schema-version marker: no bootstrap table, and
 * it is written inside the same transaction as the DDL it describes, so a crash
 * mid-migration rolls the version back with the schema.
 */
import type BetterSqlite3 from 'better-sqlite3'
import { MIGRATIONS } from '@main/db/schema'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'

function currentVersion(db: BetterSqlite3.Database): number {
  const raw = db.pragma('user_version', { simple: true })
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function runMigrations(db: BetterSqlite3.Database): void {
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)

  if (pending.length === 0) {
    log.debug('db', `schema up to date at version ${from}`)
    return
  }

  for (const migration of pending) {
    // `PRAGMA user_version = ?` cannot be parameterized, so the value is
    // interpolated — validate it is a plain integer before it reaches SQL text.
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new AppError('internal', `Migration "${migration.name}" has an invalid version.`)
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
    })

    try {
      apply()
      log.info('db', `applied migration ${migration.version} (${migration.name})`)
    } catch (e) {
      // A failed migration leaves the schema at the previous version. Surfacing it
      // as an AppError lets the bootstrap show a real dialog instead of a blank window.
      throw new AppError(
        'io',
        `Database migration ${migration.version} (${migration.name}) failed.`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
}
