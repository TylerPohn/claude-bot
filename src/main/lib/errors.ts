/**
 * The single error type crossing a process boundary.
 *
 * IPC can only transport strings, so main serializes an `AppError` into the
 * message of a plain `Error` and the preload unwraps it back into an object with
 * a `.code`. The renderer switches on `code` to decide whether to show a toast, a
 * blocking dialog or an inline hint — never on the human-readable message.
 */

export type AppErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'runtime_missing'
  | 'runtime_unauthenticated'
  | 'rate_limited'
  | 'busy'
  | 'conflict'
  | 'io'
  | 'internal'

export class AppError extends Error {
  readonly code: AppErrorCode
  /** Operator-facing extra context (stderr tail, offending path, …). Never shown raw in the UI. */
  readonly detail?: string

  constructor(code: AppErrorCode, message: string, detail?: string) {
    super(message)
    // `name` is what shows up in stack traces and in `serializeError` fallbacks.
    this.name = 'AppError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }

  toJSON(): { code: AppErrorCode; message: string; detail?: string } {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail }
  }
}

/** Type guard used by IPC wrappers and by `serializeError`. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/**
 * Turn anything thrown anywhere into a stable `{ code, message, detail }` shape.
 *
 * Node system errors (`ENOENT`, `EACCES`) and better-sqlite3 errors
 * (`SQLITE_CONSTRAINT_FOREIGNKEY`) already carry a string `code`; we keep it
 * verbatim rather than flattening it to `internal`, because those codes are the
 * most useful thing in a bug report.
 */
export function serializeError(e: unknown): { code: string; message: string; detail?: string } {
  if (isAppError(e)) return e.toJSON()

  if (e instanceof Error) {
    const nativeCode = (e as Error & { code?: unknown }).code
    const code = typeof nativeCode === 'string' && nativeCode.length > 0 ? nativeCode : 'internal'
    // The stack is the detail: it is what makes an unexpected failure diagnosable.
    return e.stack ? { code, message: e.message, detail: e.stack } : { code, message: e.message }
  }

  if (typeof e === 'string') return { code: 'internal', message: e }

  try {
    return { code: 'internal', message: JSON.stringify(e) ?? 'Unknown error' }
  } catch {
    return { code: 'internal', message: 'Unknown error' }
  }
}
