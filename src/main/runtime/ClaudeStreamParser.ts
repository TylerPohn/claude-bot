/**
 * Normalizes Claude Code `--output-format stream-json` NDJSON into `RuntimeEvent`s.
 *
 * Design constraints, all of them load-bearing:
 *
 * 1. **Defensive.** A future Claude Code release will add fields and event types. An
 *    unknown `type` returns zero events; a line that is not JSON returns a
 *    `parse_error` event. This class never throws (PRD sections 28 and 37).
 * 2. **Chunk-agnostic.** `push()` receives whatever the OS pipe hands us. One chunk may
 *    hold many lines, and one line (a 200KB tool result) may span many chunks.
 * 3. **No duplicated text.** With `--include-partial-messages` the CLI emits both
 *    `stream_event` deltas *and* a final `assistant` message carrying the very same
 *    text. See `#emitStreamedTail` for the accounting that suppresses the echo.
 *
 * This module is unit-tested with `node --test --experimental-strip-types`, which
 * resolves specifiers exactly like Node does and knows nothing about the `@main/*`
 * tsconfig path alias. Value imports here therefore use a RELATIVE path with an
 * explicit `.ts` extension, which both Node and the bundler resolve. `logger.ts`
 * is itself dependency-free, so importing it pulls in nothing else.
 */
import type { RuntimeEvent } from '@shared/types/events'
import type { RateLimitInfo } from '@shared/types'
import { incrementParseErrors, log } from '../lib/logger.ts'

function countParseError(): void {
  incrementParseErrors()
}

function debugLog(msg: string, meta?: unknown): void {
  log.debug('stream-parser', msg, meta)
}

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Cap on a single tool result we forward to the UI (ARCHITECTURE section 3.3). */
const MAX_TOOL_DETAIL_CHARS = 20_000

/**
 * A single NDJSON line larger than this is treated as a corrupt stream rather than a
 * legitimate payload. Without this a runaway process could grow the buffer unbounded.
 */
const MAX_LINE_CHARS = 32 * 1024 * 1024

/** How many assistant message ids we keep de-duplication state for. */
const MAX_TRACKED_MESSAGES = 64

/** stderr / `errors[]` substring that means the `--resume` target is gone. */
export const SESSION_NOT_FOUND_MARKER = 'No conversation found with session ID'

/* ------------------------------------------------------------------ *
 * Small unknown-safe accessors
 * ------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numOr(value: unknown, fallback: number): number {
  const n = num(value)
  return n === null ? fallback : n
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Per-assistant-message text accounting used for de-duplication. */
interface MessageState {
  /** Characters of `text` already emitted as `text_delta`. */
  streamedText: number
  /** Characters of `text` seen so far across `assistant` events for this message. */
  assistantText: number
  /** The same two counters for extended thinking. */
  streamedThinking: number
  assistantThinking: number
}

function newMessageState(): MessageState {
  return { streamedText: 0, assistantText: 0, streamedThinking: 0, assistantThinking: 0 }
}

/**
 * Key used when `content_block_delta` arrives before any `message_start`. Real streams
 * always open with `message_start`, but if that ever changes we must not lose the
 * de-duplication accounting, so the orphan state is adopted by the next `assistant`
 * event carrying an unseen message id. The leading space cannot collide with a real
 * Anthropic message id.
 */
const ORPHAN_KEY = ' pending'

export class ClaudeStreamParser {
  #buffer = ''
  #sessionId: string | null = null
  #model: string | null = null
  /** Message id from the most recent `message_start`; owns incoming deltas. */
  #currentMessageId: string | null = null
  #messages = new Map<string, MessageState>()

  /** Session id from `system/init`, available as soon as that line is parsed. */
  get sessionId(): string | null {
    return this.#sessionId
  }

  /**
   * Feed a raw stdout chunk. Returns zero or more normalized events, in stream order.
   * Safe to call with partial lines, many lines at once, or an empty string.
   */
  push(chunk: string): RuntimeEvent[] {
    if (!chunk) return []
    this.#buffer += chunk

    const events: RuntimeEvent[] = []
    let start = 0

    for (;;) {
      const nl = this.#buffer.indexOf('\n', start)
      if (nl === -1) break
      // Slice out the line and drop a trailing CR so CRLF streams parse identically.
      let line = this.#buffer.slice(start, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      start = nl + 1
      this.#consumeLine(line, events)
    }

    if (start > 0) this.#buffer = this.#buffer.slice(start)

    if (this.#buffer.length > MAX_LINE_CHARS) {
      // Refuse to grow without bound. Report it and resynchronize on the next newline.
      const raw = this.#buffer.slice(0, 200)
      this.#buffer = ''
      countParseError()
      events.push({
        type: 'parse_error',
        raw,
        error: `stream line exceeded ${MAX_LINE_CHARS} characters; buffer discarded`
      })
    }

    return events
  }

  /** Flush a trailing line that arrived without a final newline (normal at EOF). */
  flush(): RuntimeEvent[] {
    const events: RuntimeEvent[] = []
    let line = this.#buffer
    this.#buffer = ''
    if (line.endsWith('\r')) line = line.slice(0, -1)
    this.#consumeLine(line, events)
    return events
  }

  /* ---------------------------------------------------------------- *
   * Line handling
   * ---------------------------------------------------------------- */

  #consumeLine(line: string, out: RuntimeEvent[]): void {
    if (line.trim().length === 0) return

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      countParseError()
      out.push({
        type: 'parse_error',
        raw: line.length > 2000 ? `${line.slice(0, 2000)}...` : line,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    if (!isRecord(parsed)) {
      debugLog('ignoring non-object stream line', { line: line.slice(0, 200) })
      return
    }

    this.#translate(parsed, out)
  }

  #translate(obj: JsonRecord, out: RuntimeEvent[]): void {
    switch (str(obj.type)) {
      case 'system':
        this.#onSystem(obj, out)
        return
      case 'stream_event':
        this.#onStreamEvent(obj, out)
        return
      case 'assistant':
        this.#onAssistant(obj, out)
        return
      case 'user':
        this.#onUser(obj, out)
        return
      case 'result':
        this.#onResult(obj, out)
        return
      case 'rate_limit_event':
        this.#onRateLimit(obj, out)
        return
      default:
        // Forward compatibility: a new event type must never break a running turn.
        debugLog('unknown stream event type', { type: obj.type })
        return
    }
  }

  /* ---------------------------------------------------------------- *
   * system
   * ---------------------------------------------------------------- */

  #onSystem(obj: JsonRecord, out: RuntimeEvent[]): void {
    const subtype = str(obj.subtype)

    if (subtype === 'init') {
      const sessionId = str(obj.session_id)
      if (sessionId) this.#sessionId = sessionId
      this.#model = str(obj.model)

      const mcpServers = list(obj.mcp_servers).flatMap((entry) => {
        if (!isRecord(entry)) return []
        const name = str(entry.name)
        if (!name) return []
        return [{ name, status: str(entry.status) ?? 'unknown' }]
      })

      out.push({
        type: 'session',
        sessionId: sessionId ?? '',
        model: this.#model,
        permissionMode: str(obj.permissionMode),
        cwd: str(obj.cwd),
        mcpServers,
        claudeCodeVersion: str(obj.claude_code_version)
      })
      return
    }

    if (subtype === 'status') {
      const text = str(obj.status)
      if (text) out.push({ type: 'status', text })
      return
    }

    // `thinking_tokens` and friends are high-frequency progress noise; the UI already
    // renders thinking from `thinking_delta`, so they carry no extra signal.
    debugLog('ignoring system event', { subtype })
  }

  /* ---------------------------------------------------------------- *
   * stream_event (token-level deltas)
   * ---------------------------------------------------------------- */

  #onStreamEvent(obj: JsonRecord, out: RuntimeEvent[]): void {
    const event = isRecord(obj.event) ? obj.event : null
    if (!event) return

    switch (str(event.type)) {
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : null
        const id = message ? str(message.id) : null
        this.#currentMessageId = id
        if (id) this.#stateFor(id)
        return
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null
        if (!delta) return
        const kind = str(delta.type)

        if (kind === 'text_delta') {
          const text = str(delta.text)
          if (!text) return
          this.#stateFor(this.#currentMessageId ?? ORPHAN_KEY).streamedText += text.length
          out.push({ type: 'text_delta', text })
          return
        }

        if (kind === 'thinking_delta') {
          const text = str(delta.thinking)
          if (!text) return
          this.#stateFor(this.#currentMessageId ?? ORPHAN_KEY).streamedThinking += text.length
          out.push({ type: 'thinking_delta', text })
          return
        }

        // `input_json_delta` is the tool input assembling one token at a time; we use
        // the complete `tool_use` block from the `assistant` event instead, so partial
        // JSON never reaches the UI. `signature_delta` is thinking-block cryptography.
        if (kind !== 'input_json_delta' && kind !== 'signature_delta') {
          debugLog('unknown content_block_delta type', { kind })
        }
        return
      }
      // Block/message framing carries nothing we do not already get from the
      // `assistant` events, which are authoritative for complete blocks.
      case 'content_block_start':
      case 'content_block_stop':
      case 'message_delta':
      case 'message_stop':
        return
      default:
        debugLog('unknown stream_event', { type: event.type })
        return
    }
  }

  /* ---------------------------------------------------------------- *
   * assistant (complete content blocks)
   * ---------------------------------------------------------------- */

  #onAssistant(obj: JsonRecord, out: RuntimeEvent[]): void {
    const message = isRecord(obj.message) ? obj.message : null
    if (!message) return

    const id = str(message.id) ?? ORPHAN_KEY
    const state = this.#adoptState(id)

    for (const block of list(message.content)) {
      if (!isRecord(block)) continue
      switch (str(block.type)) {
        case 'text':
          this.#emitStreamedTail(str(block.text) ?? '', state, 'text', out)
          break
        case 'thinking':
          this.#emitStreamedTail(str(block.thinking) ?? '', state, 'thinking', out)
          break
        case 'tool_use': {
          const toolUseId = str(block.id)
          const name = str(block.name)
          if (!toolUseId || !name) {
            debugLog('tool_use block missing id/name', { block })
            break
          }
          out.push({ type: 'tool_start', toolUseId, name, input: block.input ?? null })
          break
        }
        default:
          // `redacted_thinking`, future block types: nothing sensible to render.
          debugLog('unknown assistant content block', { type: block.type })
          break
      }
    }
  }

  /**
   * Emit only the portion of a completed block that was *not* already streamed.
   *
   * Claude Code emits one `assistant` event per completed content block, in block
   * order, so the running `assistantText` counter is that block's offset into the
   * message's logical text. Anything below `streamedText` already reached the UI as a
   * delta and must be dropped - otherwise every reply would render twice.
   *
   * With `--include-partial-messages` off there are no deltas, `streamedText` stays 0,
   * and the whole block is emitted. That is what makes one code path correct in both
   * modes, including a turn that starts partial and loses deltas mid-flight.
   */
  #emitStreamedTail(
    text: string,
    state: MessageState,
    channel: 'text' | 'thinking',
    out: RuntimeEvent[]
  ): void {
    if (!text) return

    const seenKey = channel === 'text' ? 'assistantText' : 'assistantThinking'
    const streamedKey = channel === 'text' ? 'streamedText' : 'streamedThinking'

    const blockStart = state[seenKey]
    const blockEnd = blockStart + text.length
    state[seenKey] = blockEnd

    const streamed = state[streamedKey]
    if (blockEnd <= streamed) return // fully streamed already: the usual case

    const tail = text.slice(Math.max(0, streamed - blockStart))
    if (!tail) return

    if (channel === 'text') out.push({ type: 'text_block', text: tail })
    else out.push({ type: 'thinking_delta', text: tail })
  }

  /* ---------------------------------------------------------------- *
   * user (tool results)
   * ---------------------------------------------------------------- */

  #onUser(obj: JsonRecord, out: RuntimeEvent[]): void {
    const message = isRecord(obj.message) ? obj.message : null
    if (!message) return

    // The sibling `tool_use_result` carries the structured payload (stdout/stderr for
    // Bash, structuredPatch for Edit, ...). It belongs to the whole line, so every
    // tool_result block on this line shares it - in practice there is exactly one.
    const structured = obj.tool_use_result ?? null

    for (const block of list(message.content)) {
      if (!isRecord(block)) continue
      if (str(block.type) !== 'tool_result') continue

      const toolUseId = str(block.tool_use_id)
      if (!toolUseId) {
        debugLog('tool_result missing tool_use_id', { block })
        continue
      }

      out.push({
        type: 'tool_end',
        toolUseId,
        isError: block.is_error === true,
        content: flattenToolContent(block.content),
        structured
      })
    }
  }

  /* ---------------------------------------------------------------- *
   * result (terminal)
   * ---------------------------------------------------------------- */

  #onResult(obj: JsonRecord, out: RuntimeEvent[]): void {
    const isError = obj.is_error === true

    // A dead `--resume` target reports `error_during_execution` with the real cause in
    // `errors[]` (and on stderr). Normalizing it here means the scheduler sees one
    // unambiguous subtype and can recreate the session without racing the stderr pipe.
    const sessionNotFound = list(obj.errors).some(
      (e) => typeof e === 'string' && e.includes(SESSION_NOT_FOUND_MARKER)
    )

    const subtype = sessionNotFound
      ? 'session_not_found'
      : (str(obj.subtype) ?? (isError ? 'error' : 'success'))

    const usageRaw = isRecord(obj.usage) ? obj.usage : null
    const usage = usageRaw
      ? {
          inputTokens: numOr(usageRaw.input_tokens, 0),
          outputTokens: numOr(usageRaw.output_tokens, 0),
          cacheReadInputTokens: numOr(usageRaw.cache_read_input_tokens, 0),
          cacheCreationInputTokens: numOr(usageRaw.cache_creation_input_tokens, 0)
        }
      : null

    out.push({
      type: 'result',
      isError,
      subtype,
      resultText: str(obj.result),
      // The id echoed on a session-not-found line is the *requested* id, which no
      // longer exists; persisting it would make the next turn fail the same way.
      sessionId: sessionNotFound ? null : (this.#sessionId ?? str(obj.session_id)),
      usage,
      costUsd: num(obj.total_cost_usd),
      durationMs: num(obj.duration_ms),
      numTurns: num(obj.num_turns),
      model: this.#model ?? dominantModel(obj.modelUsage),
      permissionDenials: list(obj.permission_denials)
    })
  }

  /* ---------------------------------------------------------------- *
   * rate limits
   * ---------------------------------------------------------------- */

  #onRateLimit(obj: JsonRecord, out: RuntimeEvent[]): void {
    const raw = isRecord(obj.rate_limit_info) ? obj.rate_limit_info : null
    if (!raw) return
    const info: RateLimitInfo = {
      status: str(raw.status) ?? 'unknown',
      resetsAt: num(raw.resetsAt),
      rateLimitType: str(raw.rateLimitType)
    }
    out.push({ type: 'rate_limit', info })
  }

  /* ---------------------------------------------------------------- *
   * message state bookkeeping
   * ---------------------------------------------------------------- */

  #stateFor(id: string): MessageState {
    let state = this.#messages.get(id)
    if (!state) {
      state = newMessageState()
      this.#messages.set(id, state)
      // Map iteration is insertion-ordered, so the first key is the oldest message.
      while (this.#messages.size > MAX_TRACKED_MESSAGES) {
        const oldest = this.#messages.keys().next()
        if (oldest.done) break
        this.#messages.delete(oldest.value)
      }
    }
    return state
  }

  /**
   * Resolve the state for an `assistant` message id, taking over any orphaned delta
   * accounting recorded before a `message_start` was seen.
   */
  #adoptState(id: string): MessageState {
    const existing = this.#messages.get(id)
    if (existing) return existing

    const orphan = this.#messages.get(ORPHAN_KEY)
    if (orphan && id !== ORPHAN_KEY) {
      this.#messages.delete(ORPHAN_KEY)
      this.#messages.set(id, orphan)
      return orphan
    }
    return this.#stateFor(id)
  }
}

/**
 * `tool_result.content` is a plain string for most tools and an array of content
 * blocks for others (MCP tools return `[{type:'text',text}]`, ToolSearch returns
 * `[{type:'tool_reference',tool_name}]`). Flatten both into displayable text.
 */
export function flattenToolContent(content: unknown): string {
  const text = flattenRaw(content)
  return text.length > MAX_TOOL_DETAIL_CHARS
    ? `${text.slice(0, MAX_TOOL_DETAIL_CHARS)}\n... truncated ...`
    : text
}

function flattenRaw(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (isRecord(entry)) {
          const text = str(entry.text)
          if (text !== null) return text
        }
        // Unknown block shape (tool_reference, image, ...): keep it in the expanded
        // detail view rather than silently dropping evidence.
        return safeStringify(entry)
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }

  return safeStringify(content)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * `modelUsage` maps model id to usage. A turn can touch several models (Claude Code
 * uses a small one for side tasks such as titling), so pick the model that actually
 * produced the answer: the highest output-token count.
 */
function dominantModel(modelUsage: unknown): string | null {
  if (!isRecord(modelUsage)) return null
  let best: string | null = null
  let bestTokens = -1
  for (const [name, value] of Object.entries(modelUsage)) {
    const tokens = isRecord(value) ? numOr(value.outputTokens, 0) : 0
    if (tokens > bestTokens) {
      bestTokens = tokens
      best = name
    }
  }
  return best
}
