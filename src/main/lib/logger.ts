/**
 * Tiny structured logger with a rolling in-memory buffer.
 *
 * There is deliberately no file transport: the interesting failures in this app
 * (Claude Code not on PATH, a session that will not resume, a malformed NDJSON
 * line) all happen inside a few seconds of user action, and "Copy Diagnostics"
 * pastes the tail of this buffer straight into a bug report. Keeping the buffer
 * bounded means a long streaming session cannot grow it without limit.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** How many formatted lines "Copy Diagnostics" can show. */
const RING_CAPACITY = 500
/** Metadata longer than this is truncated — a 200KB tool result must not land in the ring. */
const META_MAX_CHARS = 600

const ring: string[] = []

/**
 * Count of NDJSON lines the stream parser could not decode. Surfaced in the
 * diagnostics report: a non-zero value here is the single strongest signal that
 * Claude Code changed its output format.
 */
let parseErrors = 0

/** Debug lines still reach the ring buffer in production; they just stay off the console. */
const consoleDebugEnabled = process.env.NODE_ENV !== 'production' || process.env.CCB_DEBUG === '1'

function formatMeta(meta: unknown): string {
  if (meta === undefined) return ''
  if (typeof meta === 'string') return ` ${truncate(meta)}`
  if (meta instanceof Error) return ` ${meta.name}: ${meta.message}`
  try {
    return ` ${truncate(JSON.stringify(meta) ?? String(meta))}`
  } catch {
    // Circular structures and BigInt both make JSON.stringify throw.
    return ' [unserializable meta]'
  }
}

function truncate(text: string): string {
  return text.length > META_MAX_CHARS ? `${text.slice(0, META_MAX_CHARS)}…` : text
}

function write(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${formatMeta(meta)}`

  ring.push(line)
  if (ring.length > RING_CAPACITY) ring.shift()

  switch (level) {
    case 'debug':
      if (consoleDebugEnabled) console.debug(line)
      break
    case 'info':
      console.info(line)
      break
    case 'warn':
      console.warn(line)
      break
    case 'error':
      console.error(line)
      break
  }
}

export const log = {
  debug(scope: string, msg: string, meta?: unknown): void {
    write('debug', scope, msg, meta)
  },
  info(scope: string, msg: string, meta?: unknown): void {
    write('info', scope, msg, meta)
  },
  warn(scope: string, msg: string, meta?: unknown): void {
    write('warn', scope, msg, meta)
  },
  error(scope: string, msg: string, meta?: unknown): void {
    write('error', scope, msg, meta)
  }
} as const

/** Rolling in-memory ring buffer of the last 500 lines, for Copy Diagnostics. */
export function recentLogs(): string[] {
  return ring.slice()
}

export function incrementParseErrors(): void {
  parseErrors += 1
}

export function parseErrorCount(): number {
  return parseErrors
}
