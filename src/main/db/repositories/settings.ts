/**
 * Application settings.
 *
 * Stored as one JSON-encoded row per key rather than a single blob, so a patch
 * touches only the keys it names and a corrupt value can be dropped in isolation
 * instead of taking every other setting down with it. Every value read back from
 * disk is re-validated against the same rules the IPC schema enforces — settings
 * feed straight into process spawning (model, permission mode, tool lists), so a
 * hand-edited database must not be able to smuggle in a nonsense value.
 */
import type { AppSettings, Appearance, ModelPreference, PermissionMode } from '@shared/types'
import { getDb, stmt, transaction } from '@main/db/index'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'
import type BetterSqlite3 from 'better-sqlite3'

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  appearance: 'system',
  launchAtLogin: false,
  showNotifications: true,
  notifyOnFocusedConversation: false,
  defaultWorkspace: null,
  /** Three concurrent Claude processes is what a laptop and a subscription both tolerate. */
  maxConcurrentBots: 3,
  /** Off by default: the same Bot answering in two places at once reads as chaos (PRD §23.2). */
  allowSameBotConcurrentConversations: false,
  claudeExecutablePath: null,
  defaultModel: 'default',
  defaultPermissionMode: 'default',
  globalAllowedTools: [],
  globalDisallowedTools: [],
  safetyGuardrails: true,
  handoffsEnabled: true,
  maxHandoffDepth: 3,
  maxAutomatedTurnsPerHumanMessage: 8,
  groupBridgeCharBudget: 24000,
  showThinking: false,
  sendKey: 'enter',
  onboardingCompleted: false,
  fontScale: 1
})

/* ------------------------------------------------------------------ *
 * Per-key validation
 * ------------------------------------------------------------------ */

type Validator<K extends keyof AppSettings> = (value: unknown) => AppSettings[K] | undefined

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function intInRange(min: number, max: number) {
  return (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

function numberInRange(min: number, max: number) {
  return (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined
}

function oneOf<T extends string>(allowed: readonly T[]) {
  return (value: unknown): T | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']
const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]

/** Free-form so a full model id can be pinned, but it ends up on a command line. */
function model(value: unknown): ModelPreference | undefined {
  return typeof value === 'string' && value.length > 0 && /^[a-zA-Z0-9._-]+$/.test(value) ? value : undefined
}

const VALIDATORS: { [K in keyof AppSettings]: Validator<K> } = {
  appearance: oneOf(APPEARANCES),
  launchAtLogin: bool,
  showNotifications: bool,
  notifyOnFocusedConversation: bool,
  defaultWorkspace: nullableString,
  maxConcurrentBots: intInRange(1, 12),
  allowSameBotConcurrentConversations: bool,
  claudeExecutablePath: nullableString,
  defaultModel: model,
  defaultPermissionMode: oneOf(PERMISSION_MODES),
  globalAllowedTools: stringArray,
  globalDisallowedTools: stringArray,
  safetyGuardrails: bool,
  handoffsEnabled: bool,
  maxHandoffDepth: intInRange(0, 6),
  maxAutomatedTurnsPerHumanMessage: intInRange(1, 32),
  groupBridgeCharBudget: intInRange(1000, 200000),
  showThinking: bool,
  sendKey: oneOf(['enter', 'mod+enter'] as const),
  onboardingCompleted: bool,
  fontScale: numberInRange(0.85, 1.3)
}

const SETTING_KEYS = Object.keys(VALIDATORS) as Array<keyof AppSettings>

/* ------------------------------------------------------------------ *
 * Statements + cache
 * ------------------------------------------------------------------ */

const selectAll = stmt<{ key: string; value: string }>('SELECT key, value FROM settings')
const selectOne = stmt<{ value: string }>('SELECT value FROM settings WHERE key = ?')
const upsertOne = stmt(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
)

/**
 * Settings are read on nearly every job admission, notification and prompt build,
 * and this process is the only writer, so the merged object is memoized until the
 * next write. The cache is tied to the database instance so a test that reopens
 * the database gets a clean read.
 */
let cache: AppSettings | null = null
let cachedFor: BetterSqlite3.Database | null = null

function readAll(): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of selectAll().all()) {
    const key = row.key as keyof AppSettings
    const validate = VALIDATORS[key] as Validator<keyof AppSettings> | undefined
    // Unknown keys are other modules' private state (window bounds, for example).
    if (!validate) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(row.value)
    } catch {
      log.warn('settings', `dropping unparseable value for "${row.key}"`)
      continue
    }

    const value = validate(parsed)
    if (value === undefined) {
      log.warn('settings', `dropping out-of-range value for "${row.key}"`)
      continue
    }
    // Safe: `validate` is the validator for exactly this key.
    Object.assign(merged, { [key]: value })
  }

  return merged
}

export const settingsRepo = Object.freeze({
  get(): AppSettings {
    const db = getDb()
    if (!cache || cachedFor !== db) {
      cache = readAll()
      cachedFor = db
    }
    return cache
  },

  update(patch: Partial<AppSettings>): AppSettings {
    return transaction(() => {
      for (const [key, raw] of Object.entries(patch)) {
        // `undefined` means "not part of this patch"; null is a real value for the nullable keys.
        if (raw === undefined) continue
        const settingKey = key as keyof AppSettings
        const validate = VALIDATORS[settingKey] as Validator<keyof AppSettings> | undefined
        if (!validate) {
          throw new AppError('invalid_input', `Unknown setting "${key}".`)
        }
        const value = validate(raw)
        if (value === undefined) {
          throw new AppError('invalid_input', `Invalid value for setting "${key}".`)
        }
        upsertOne().run(key, JSON.stringify(value))
      }

      cache = null
      cachedFor = null
      return settingsRepo.get()
    })
  },

  /** The keys `AppSettings` declares — used by the backup export. */
  keys(): Array<keyof AppSettings> {
    return SETTING_KEYS.slice()
  },

  /**
   * Escape hatch for main-process state that is not part of `AppSettings` and
   * has no business in its own table — window bounds, most notably. Values are
   * JSON round-tripped and are never returned from `get()`.
   */
  getRaw<T>(key: string, fallback: T): T {
    const row = selectOne().get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  },

  setRaw(key: string, value: unknown): void {
    if ((SETTING_KEYS as string[]).includes(key)) {
      throw new AppError('invalid_input', `"${key}" is a declared setting; use update() so it stays validated.`)
    }
    upsertOne().run(key, JSON.stringify(value ?? null))
  }
})
