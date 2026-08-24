/**
 * Local diagnostics (PRD §40). There is no remote telemetry in v1 — this is the
 * payload behind the "Copy diagnostics" button, assembled on demand so nothing
 * is collected unless the user asks for it.
 */
import { app } from 'electron'
import { homedir } from 'node:os'

import { nowIso } from '@main/lib/id'
import { log, parseErrorCount } from '@main/lib/logger'
import { databasePath } from '@main/lib/paths'
import { settingsRepo, DEFAULT_SETTINGS } from '@main/db/repositories/settings'
import { getRuntime } from '@main/runtime/ClaudeCodeRuntime'
import type { AppSettings, DiagnosticsReport } from '@shared/types'

interface ExitRecord {
  jobId: string
  code: number | null
  signal: string | null
  at: string
}

/**
 * Bounded ring buffer of recent CLI process exits. Twenty is what the report
 * shows and what a bug report needs; older entries are dropped rather than
 * growing a long-lived main-process array.
 */
const MAX_EXITS = 20
const exits: ExitRecord[] = []

export function recordExit(jobId: string, code: number | null, signal: string | null): void {
  exits.push({ jobId, code, signal, at: nowIso() })
  if (exits.length > MAX_EXITS) exits.splice(0, exits.length - MAX_EXITS)
}

/** Newest first — the exit the user just hit is the one they care about. */
export function recentExits(): ExitRecord[] {
  return exits.slice().reverse()
}

/**
 * Collapse the home directory to `~` everywhere it appears in a string.
 *
 * A diagnostics report is written to be pasted into a public issue tracker, and
 * every absolute path in it carried the account username: the executable path,
 * the database path, `defaultWorkspace`, and tool patterns like
 * `Bash(cd /Users/x/clients/acme:*)`, which leak a project name too. `~` keeps
 * the line's whole diagnostic value — "which claude binary is this" is the most
 * useful answer in the report — without naming the person.
 *
 * The match is anchored to a path boundary so `/Users/sam2/x` cannot become
 * `~2/x`, and it is not anchored to the start of the string because the paths
 * that matter most are embedded mid-value.
 */
function tildify(value: string): string {
  const home = homedir().replace(/[/\\]+$/, '')
  if (home.length === 0) return value

  let out = ''
  let index = 0
  for (;;) {
    const at = value.indexOf(home, index)
    if (at === -1) return out + value.slice(index)
    const next = value[at + home.length]
    const boundary = next === undefined || next === '/' || next === '\\'
    out += value.slice(index, at) + (boundary ? '~' : home)
    index = at + home.length
  }
}

/** `tildify` over strings and string arrays; anything else passes through. */
function tildifyDeep<T>(value: T): T {
  if (typeof value === 'string') return tildify(value) as T
  if (Array.isArray(value)) return value.map((item) => tildifyDeep(item)) as T
  return value
}

export async function buildReport(): Promise<DiagnosticsReport> {
  // The runtime status is cached for 60s inside the runtime singleton, so this
  // is cheap and will not shell out on every click.
  let claudeVersion: string | null = null
  let claudeExecutablePath: string | null = null
  try {
    const status = await getRuntime().checkAvailability()
    claudeVersion = status.version
    claudeExecutablePath = status.executablePath
  } catch (err) {
    // A diagnostics report that fails to build is worse than an incomplete one.
    log.warn('diagnostics', 'could not read runtime status', err)
  }

  let settings = DEFAULT_SETTINGS
  try {
    settings = settingsRepo.get()
  } catch (err) {
    log.warn('diagnostics', 'could not read settings', err)
  }

  // Every path leaves here shortened. The report is assembled for a clipboard
  // that ends up in a bug report, so the redaction belongs at the boundary that
  // builds it rather than in whichever surface happens to print it.
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    claudeVersion,
    claudeExecutablePath: claudeExecutablePath === null ? null : tildify(claudeExecutablePath),
    dbPath: tildify(databasePath()),
    parseErrors: parseErrorCount(),
    recentExitCodes: recentExits(),
    // A loop rather than a field list, so a path-valued setting added later is
    // covered without anyone having to remember this file exists.
    settings: Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [key, tildifyDeep(value)])
    ) as AppSettings
  }
}
