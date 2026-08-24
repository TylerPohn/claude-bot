/**
 * The renderer's single door to the main process.
 *
 * ERROR UNWRAPPING. Electron transports only an Error's `message` across the ipc
 * + contextBridge boundary, so main serializes `{code, message, detail}` into the
 * message between `__CCB_ERR__` / `__CCB_END__` markers (see
 * `src/main/ipc/index.ts`). The preload normally rebuilds a real `Error` carrying
 * `.code` inside the renderer's world; when `contextBridge.executeInMainWorld`
 * is unavailable it falls back to rejecting with a plain envelope object.
 * `toAppError` handles all three shapes — rebuilt Error, plain envelope, and a
 * raw Error whose message still contains the markers — so callers always get an
 * `Error` with a usable `.code`.
 */
import type { BotApi } from '@shared/types/api'
import { useUiStore } from '@/stores/uiStore'

/**
 * Mirrors `AppErrorCode` in `src/main/lib/errors.ts`. It is duplicated rather
 * than imported because the renderer's tsconfig deliberately has no `@main`
 * alias — the renderer must never be able to reach into main's source. The
 * widening `(string & {})` keeps a code from a newer main build type-checking.
 */
export type IpcErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'runtime_missing'
  | 'runtime_unauthenticated'
  | 'rate_limited'
  | 'busy'
  | 'conflict'
  | 'io'
  | 'internal'
  | (string & {})

export interface AppError extends Error {
  code: IpcErrorCode
  detail?: string
}

/** `window.botApp`, in one place, so a missing preload fails loudly and once. */
export function bridge(): BotApi {
  const api = window.botApp
  if (!api) {
    throw Object.assign(new Error('The app bridge failed to load. Restart Claude Bot.'), {
      code: 'internal' as IpcErrorCode
    })
  }
  return api
}

/** Shorthand used across the renderer: `api().bots.list()`. */
export const api = bridge

const ENVELOPE_RE = /__CCB_ERR__([\s\S]*?)__CCB_END__/

function build(code: IpcErrorCode, message: string, detail?: string): AppError {
  const err = new Error(message) as AppError
  err.name = 'AppError'
  err.code = code
  if (detail !== undefined) err.detail = detail
  return err
}

export function toAppError(thrown: unknown): AppError {
  // 1. The happy path: the preload already rebuilt a real Error with `.code`.
  if (thrown instanceof Error) {
    const withCode = thrown as AppError
    const raw = thrown.message
    const match = ENVELOPE_RE.exec(raw)
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as { code?: string; message?: string; detail?: string }
        return build(
          parsed.code ?? 'internal',
          parsed.message ?? 'Something went wrong.',
          parsed.detail
        )
      } catch {
        // Malformed envelope — fall through and keep the raw message.
      }
    }
    if (typeof withCode.code === 'string' && withCode.code.length > 0) return withCode
    return build('internal', raw || 'Something went wrong.')
  }

  // 2. The fallback path: a plain envelope object, not an instance of Error.
  if (thrown && typeof thrown === 'object') {
    const env = thrown as { message?: unknown; code?: unknown; detail?: unknown }
    if (typeof env.message === 'string') {
      return build(
        typeof env.code === 'string' ? env.code : 'internal',
        env.message,
        typeof env.detail === 'string' ? env.detail : undefined
      )
    }
  }

  // 3. Anything else — a string throw, a structured-clone failure.
  return build('internal', typeof thrown === 'string' ? thrown : 'Something went wrong.')
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof Error && typeof (value as AppError).code === 'string'
}

export function errorCode(thrown: unknown): IpcErrorCode {
  return toAppError(thrown).code
}

export function errorMessage(thrown: unknown): string {
  return toAppError(thrown).message
}

/** Run an IPC call, normalising whatever it throws into an `AppError`. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (thrown) {
    throw toAppError(thrown)
  }
}

export interface WithToastOptions {
  /** Shown as the toast title on failure. Defaults to "Something went wrong". */
  errorTitle?: string
  /** Shown as a success toast when provided. Silent otherwise. */
  successTitle?: string
  /** Rethrow after toasting. Off by default — callers usually just want the null. */
  rethrow?: boolean
  /** Codes that should stay silent (e.g. a cancel the user asked for). */
  silentCodes?: IpcErrorCode[]
}

/**
 * The default way to call IPC from a component: failures become a toast instead
 * of an unhandled rejection, and the caller gets `null` back.
 *
 * `runtime_missing` / `runtime_unauthenticated` are special-cased with the
 * remediation the user actually needs, because "Error: ENOENT" is useless copy.
 */
export async function withToast<T>(
  fn: () => Promise<T>,
  options: WithToastOptions = {}
): Promise<T | null> {
  const { toast } = useUiStore.getState()
  try {
    const result = await fn()
    if (options.successTitle) toast({ level: 'success', title: options.successTitle })
    return result
  } catch (thrown) {
    const err = toAppError(thrown)
    if (options.silentCodes?.includes(err.code)) return null

    if (err.code === 'runtime_missing') {
      toast({
        level: 'error',
        title: 'Claude Code was not found',
        body: 'Set the executable path in Settings → Claude Code, or install it and recheck.',
        actionLabel: 'Open settings',
        onAction: () => useUiStore.getState().openModal({ kind: 'settings', tab: 'claude' })
      })
    } else if (err.code === 'runtime_unauthenticated') {
      toast({
        level: 'error',
        title: 'Claude Code is not signed in',
        body: 'Run `claude` in a terminal once to sign in, then recheck.',
        actionLabel: 'Open Terminal',
        onAction: () => {
          void bridge().runtime.openLoginTerminal()
        }
      })
    } else if (err.code === 'rate_limited') {
      toast({
        level: 'warn',
        title: 'Claude Code usage limit reached',
        body: 'Your Bot history is safe. Retry after your Claude allowance resets.'
      })
    } else {
      toast({
        level: 'error',
        title: options.errorTitle ?? 'Something went wrong',
        body: err.message
      })
    }

    if (options.rethrow) throw err
    return null
  }
}
