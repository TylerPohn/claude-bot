/**
 * Local MCP stdio bridge — a separate build entry, emitted next to the main
 * bundle in `out/main/` and launched by the Claude Code CLI, not by us.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS SELF-CONTAINED
 *
 * This script runs in its own process, spawned by the CLI as
 *   `<electron binary> <this file>`  with  ELECTRON_RUN_AS_NODE=1
 * (a packaged app cannot assume a plain `node` exists on PATH — Electron always
 * does). In that mode there is no `electron` module, no app bundle and no
 * module resolution beyond this file. It therefore imports **nothing but
 * `node:` builtins** — no shared types, no zod, no logger. The constants and
 * tool definitions below are intentionally duplicated from
 * `src/main/mcp/protocol.ts`; that module remains the documented source of
 * truth and the two must be edited together.
 *
 * WHY NOTHING MAY TOUCH STDOUT
 *
 * stdout *is* the MCP transport: newline-delimited JSON-RPC 2.0 frames. A
 * single stray `console.log` desynchronises the client's line reader and the
 * CLI drops the server. Every diagnostic in this file goes to stderr, which the
 * CLI collects separately.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'

/* ------------------------------------------------------------------ *
 * Constants (mirrored from src/main/mcp/protocol.ts — keep in sync)
 * ------------------------------------------------------------------ */

const MCP_PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'claude_code_bots'
const SERVER_VERSION = '1.0.0'

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603
const ERR_PARSE = -32700

const CONTROL_RPC_PATH = '/rpc'

/** Give up on a control call well before the CLI gives up on us. */
const CONTROL_TIMEOUT_MS = 30_000

/**
 * Refuse to buffer an unbounded stdin line. The CLI only ever sends small
 * frames; anything past this is a desync and we resync at the next newline.
 */
const MAX_LINE_CHARS = 4 * 1024 * 1024

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: 'string'; description: string }>
    required: string[]
    additionalProperties: false
  }
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'send_message_to_bot',
    description: [
      'Hand a piece of work to another Bot in this chat.',
      '',
      'This posts a VISIBLE message in the shared conversation, addressed to that Bot, and',
      'queues the Bot to respond on its own turn. It is NOT a synchronous function call:',
      "it returns as soon as the message is posted and it never returns the other Bot's answer.",
      'The other Bot replies asynchronously, in the conversation, after your turn ends — you',
      'will see the reply the next time you are asked to respond. Do not wait for it, do not',
      'poll for it, and never invent what the other Bot said.',
      '',
      'Use this when another Bot is genuinely better suited to part of the work. Write the',
      'message as if you were speaking to a colleague: state what you need, name the files or',
      'commands involved, and include enough context that they can act without re-reading the',
      'whole conversation. Call list_bots first if you are unsure who is here or how a name is',
      'spelled. To answer the human, just write your reply normally — do not use this tool.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        bot_name: {
          type: 'string',
          description:
            'Exact name of a Bot in this conversation, as returned by list_bots. Case-insensitive.'
        },
        message: {
          type: 'string',
          description:
            'The message to post for that Bot. Self-contained: say what you need and why, with the relevant paths or commands.'
        }
      },
      required: ['bot_name', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'send_message_to_group',
    description: [
      'Post a VISIBLE message to everyone in this conversation — the human and every other Bot.',
      '',
      'Like send_message_to_bot, this is asynchronous: it returns as soon as the message is',
      "posted and never returns anyone's answer. Replies appear in the conversation after your",
      'turn ends.',
      '',
      'Use this sparingly — for a status update, a blocking question, or a heads-up that the',
      'whole group needs. If exactly one Bot should act, use send_message_to_bot instead so the',
      'work is not duplicated. If you are simply answering the human, write your reply normally',
      'rather than calling this tool.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to post to the whole conversation.'
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'list_bots',
    description: [
      'List the Bots that are members of this conversation, with their names and roles.',
      '',
      'Read-only and instant — it does not post anything. Call it before send_message_to_bot',
      'when you are not certain who is available or exactly how a name is spelled; bot_name must',
      'match one of the names returned here.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
]

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

interface BridgeEnv {
  port: number
  token: string
}

/**
 * Read the two values the app injected through `--mcp-config`. Missing or
 * malformed values are not fatal: `initialize` and `tools/list` still work, and
 * each `tools/call` returns a readable `isError` result. Crashing here would
 * make the CLI report an opaque "MCP server failed to start".
 *
 * There is deliberately no identity here. The token is issued for one turn and
 * the app resolves "which Bot, which conversation" from it server-side; this
 * process is not trusted to state who it is.
 */
function readEnv(): BridgeEnv | null {
  const rawPort = process.env['CCB_PORT']
  const token = process.env['CCB_TOKEN']
  const port = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (!token) return null
  return { port, token }
}

const env = readEnv()

/* ------------------------------------------------------------------ *
 * Transport helpers
 * ------------------------------------------------------------------ */

function logStderr(message: string): void {
  // Trailing newline keeps our lines from merging with the CLI's own stderr.
  process.stderr.write(`[claude-code-bots mcp] ${message}\n`)
}

function writeFrame(frame: unknown): void {
  let encoded: string
  try {
    encoded = JSON.stringify(frame)
  } catch (err) {
    // A non-serializable frame would break the stream; drop it and say why.
    logStderr(`failed to serialize response: ${String(err)}`)
    return
  }
  process.stdout.write(`${encoded}\n`)
}

type JsonRpcId = string | number | null

function respond(id: JsonRpcId, result: unknown): void {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
}

/** MCP tool results carry failures in-band so the model can read and recover from them. */
function toolResult(text: string, isError: boolean): unknown {
  return { content: [{ type: 'text', text }], isError }
}

/* ------------------------------------------------------------------ *
 * Control-server call
 * ------------------------------------------------------------------ */

interface ControlResult {
  ok: boolean
  text: string
}

/**
 * POST the tool invocation to the Electron main process, which owns the
 * database and the scheduler. Never rejects: any transport failure comes back
 * as `{ ok: false }` with a sentence the model can act on.
 */
function callControlServer(
  tool: string,
  args: Record<string, unknown>,
  bridge: BridgeEnv
): Promise<ControlResult> {
  return new Promise<ControlResult>((resolve) => {
    let settled = false
    const finish = (result: ControlResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // Tool + arguments only. The server derives the calling Bot and
    // conversation from the bearer token; a body that names them is refused.
    const payload = JSON.stringify({ tool, arguments: args })
    const body = Buffer.from(payload, 'utf8')

    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: bridge.port,
        path: CONTROL_RPC_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
          authorization: `Bearer ${bridge.token}`
        }
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            finish({
              ok: false,
              text: `Claude Code Bots rejected the request (HTTP ${res.statusCode ?? 0}). ${text.slice(0, 500)}`.trim()
            })
            return
          }
          try {
            const parsed: unknown = JSON.parse(text)
            if (parsed && typeof parsed === 'object') {
              const record = parsed as { ok?: unknown; text?: unknown }
              finish({
                ok: record.ok === true,
                text: typeof record.text === 'string' ? record.text : ''
              })
              return
            }
            finish({ ok: false, text: 'Claude Code Bots returned an unexpected response.' })
          } catch {
            finish({ ok: false, text: 'Claude Code Bots returned a malformed response.' })
          }
        })
        res.on('error', (err: Error) => {
          finish({ ok: false, text: `Lost the connection to Claude Code Bots: ${err.message}` })
        })
      }
    )

    req.on('error', (err: Error) => {
      finish({
        ok: false,
        text:
          `Could not reach the Claude Code Bots app (${err.message}). ` +
          'The app may have been closed. Continue with your own work and tell the human that the handoff did not go through.'
      })
    })

    req.setTimeout(CONTROL_TIMEOUT_MS, () => {
      req.destroy()
      finish({
        ok: false,
        text: 'The Claude Code Bots app did not respond in time. The handoff was not delivered.'
      })
    })

    req.end(body)
  })
}

/* ------------------------------------------------------------------ *
 * Argument validation
 * ------------------------------------------------------------------ */

function readStringArg(
  args: Record<string, unknown>,
  key: string
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = args[key]
  if (typeof raw !== 'string') {
    return { ok: false, message: `\`${key}\` is required and must be a string.` }
  }
  const value = raw.trim()
  if (value.length === 0) {
    return { ok: false, message: `\`${key}\` must not be empty.` }
  }
  return { ok: true, value }
}

/* ------------------------------------------------------------------ *
 * Method dispatch
 * ------------------------------------------------------------------ */

async function handleToolsCall(id: JsonRpcId, params: unknown): Promise<void> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown }
  const name = typeof p.name === 'string' ? p.name : ''
  const rawArgs = p.arguments
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}

  if (!name) {
    respondError(id, ERR_INVALID_PARAMS, 'tools/call requires a "name" parameter')
    return
  }

  // Unknown tools come back as an in-band tool error rather than a JSON-RPC
  // error: the model can read the message and correct itself, where a protocol
  // error just surfaces as an opaque failure.
  if (!TOOL_NAMES.has(name)) {
    respond(
      id,
      toolResult(
        `Unknown tool "${name}". Available tools: ${[...TOOL_NAMES].join(', ')}.`,
        true
      )
    )
    return
  }

  if (!env) {
    respond(
      id,
      toolResult(
        'Claude Code Bots did not pass connection details to this MCP server, so Bot-to-Bot handoffs are unavailable for this run. Continue on your own and mention the failure in your reply.',
        true
      )
    )
    return
  }

  const forwarded: Record<string, unknown> = {}

  if (name === 'send_message_to_bot') {
    const botName = readStringArg(args, 'bot_name')
    if (!botName.ok) {
      respond(id, toolResult(botName.message, true))
      return
    }
    const message = readStringArg(args, 'message')
    if (!message.ok) {
      respond(id, toolResult(message.message, true))
      return
    }
    forwarded['bot_name'] = botName.value
    forwarded['message'] = message.value
  } else if (name === 'send_message_to_group') {
    const message = readStringArg(args, 'message')
    if (!message.ok) {
      respond(id, toolResult(message.message, true))
      return
    }
    forwarded['message'] = message.value
  }

  const result = await callControlServer(name, forwarded, env)
  respond(id, toolResult(result.text || (result.ok ? 'Done.' : 'The request failed.'), !result.ok))
}

async function handleMessage(message: JsonRpcMessageLike): Promise<void> {
  const { method, params } = message
  // A notification has no `id` at all. Per JSON-RPC we must stay silent on those.
  const isNotification = message.id === undefined
  const id: JsonRpcId = message.id === undefined ? null : message.id

  switch (method) {
    case 'initialize': {
      respond(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      })
      return
    }

    case 'notifications/initialized':
    case 'initialized': {
      // Handshake completion. No response — it is a notification.
      return
    }

    case 'tools/list': {
      respond(id, { tools: TOOLS })
      return
    }

    case 'tools/call': {
      await handleToolsCall(id, params)
      return
    }

    case 'ping': {
      // MCP keepalive: an empty result object is the whole contract.
      respond(id, {})
      return
    }

    default: {
      if (isNotification) {
        // Unknown notifications are ignored by design (spec requirement).
        logStderr(`ignoring unknown notification: ${method}`)
        return
      }
      respondError(id, ERR_METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  }
}

interface JsonRpcMessageLike {
  id?: JsonRpcId
  method: string
  params?: unknown
}

/* ------------------------------------------------------------------ *
 * stdin line reader
 * ------------------------------------------------------------------ */

let buffer = ''
/**
 * Set after an oversized line so the remainder of that line is discarded
 * instead of being parsed as a fresh frame.
 */
let skippingOversizedLine = false

/**
 * Requests are handled in arrival order. MCP allows concurrency, but a handoff
 * mutates conversation state, and serialising here removes any chance of two
 * calls racing on the same conversation.
 */
let queue: Promise<void> = Promise.resolve()

function enqueue(line: string): void {
  queue = queue.then(() => processLine(line)).catch((err: unknown) => {
    logStderr(`unhandled error while processing a frame: ${String(err)}`)
  })
}

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim()
  if (!trimmed) return

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    respondError(null, ERR_PARSE, 'Invalid JSON')
    return
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Batches are not part of the MCP stdio profile; reject rather than guess.
    respondError(null, ERR_PARSE, 'Expected a single JSON-RPC object')
    return
  }

  const record = parsed as Record<string, unknown>
  if (typeof record['method'] !== 'string') {
    // A response (not a request) — the CLI does not send us those, so ignore it.
    return
  }

  const rawId = record['id']
  const message: JsonRpcMessageLike = {
    method: record['method'],
    params: record['params']
  }
  if (rawId !== undefined) {
    message.id =
      typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  }

  try {
    await handleMessage(message)
  } catch (err) {
    logStderr(`handler threw: ${String(err)}`)
    if (message.id !== undefined) {
      respondError(message.id, ERR_INTERNAL, 'Internal error in the Claude Code Bots MCP bridge')
    }
  }
}

process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk: string) => {
  buffer += chunk

  for (;;) {
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) break
    const line = buffer.slice(0, newlineIndex)
    buffer = buffer.slice(newlineIndex + 1)
    if (skippingOversizedLine) {
      skippingOversizedLine = false
      continue
    }
    enqueue(line)
  }

  if (buffer.length > MAX_LINE_CHARS) {
    logStderr(`dropping an oversized frame (> ${MAX_LINE_CHARS} chars)`)
    buffer = ''
    skippingOversizedLine = true
  }
})

process.stdin.on('end', () => {
  // The CLI closed the transport: finish whatever is queued, then exit cleanly.
  const remainder = buffer
  buffer = ''
  if (remainder.trim() && !skippingOversizedLine) enqueue(remainder)
  queue
    .then(() => process.exit(0))
    .catch(() => process.exit(0))
})

process.stdin.on('error', (err: Error) => {
  logStderr(`stdin error: ${err.message}`)
  process.exit(0)
})

// The CLI kills us with SIGTERM when the turn ends; exit quietly so no noise
// reaches the transcript.
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// A crash here must not take the turn down with an unreadable stack on stdout.
process.on('uncaughtException', (err: Error) => {
  logStderr(`uncaught exception: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason: unknown) => {
  logStderr(`unhandled rejection: ${String(reason)}`)
})

process.stdin.resume()
logStderr(`ready (pid ${process.pid}${env ? `, control port ${env.port}` : ', no control port'})`)
