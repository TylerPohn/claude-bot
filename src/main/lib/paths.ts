/**
 * Filesystem locations owned by the app.
 *
 * This is the ONLY module under `src/main/lib` that touches Electron, so the rest
 * of `lib` (and every repository that imports it) stays loadable from a plain
 * `node --test` process.
 */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATABASE_FILENAME } from '@main/db/index'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function databasePath(): string {
  return join(userDataDir(), DATABASE_FILENAME)
}

/**
 * Directory for exported diagnostics and backups. Created on demand: callers
 * treat the returned path as writable, and a missing directory would otherwise
 * surface as an ENOENT deep inside an export.
 */
export function logsDir(): string {
  const dir = join(userDataDir(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // A read-only or full disk is reported by the write that follows, with far
    // better context than a throw from a path accessor would give.
  }
  return dir
}

export function isMac(): boolean {
  return process.platform === 'darwin'
}
