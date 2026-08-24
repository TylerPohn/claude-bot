/**
 * Loopback control server for the Bot-to-Bot handoff bridge (PRD §13).
 *
 * The MCP bridge runs in a child process spawned by the Claude Code CLI and has
 * no access to the database or the job scheduler. This server is the only door
 * back into the app, and it is deliberately a very small one:
 *
 *   - bound to `127.0.0.1` on an ephemeral port (never `0.0.0.0`);
 *   - one route, `POST /rpc`, everything else refused;
 *   - a 32-byte bearer token minted per turn ATTEMPT and compared in constant
 *     time (see `mcpConfigForAttempt` for why an attempt, not a job);
 *   - request bodies capped at 256KB.
 *
 * The token is also the caller's identity. Each token is issued for exactly one
 * running attempt and the server holds the `token -> { botId, conversationId }`
 * mapping; the request body carries only a tool name and its arguments. That
 * matters because the handoff-depth and turn-budget guards are derived from the
 * caller's identity: when identity came out of the body (as it used to), any
 * holder of the token could impersonate any Bot and reset both guards to zero.
 *
 * Two things this is NOT:
 *   - a boundary against the user's own processes. The config document is
 *     written 0600 and the token is scoped to one turn, but any process running
 *     as the user can read the file while that turn is live.
 *   - long-lived. `revokeMcpConfig()` is called when the turn's process is
 *     reaped (see ClaudeCodeRuntime), so a leaked token dies with the turn. One
 *     ATTEMPT, note, not one job: a retried turn is re-credentialled by
 *     `mcpConfigForAttempt()`.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { app } from 'electron'

import { log } from '@main/lib/logger'
import { settingsRepo } from '@main/db/repositories/settings'
import {
  clearGrants,
  identityForToken,
  isLiveGrant,
  issueGrant,
  resolveGrant,
  retireGrant
} from './grants'
import type { JobGrant } from './grants'
import {
  CONTROL_ENV,
  CONTROL_MAX_BODY_BYTES,
  CONTROL_RPC_PATH,
  HANDOFF_TOOL,
  HANDOFF_TOOL_NAMES,
  MCP_SERVER_NAME
} from './protocol'
import type { ControlRequestBody, ControlResponseBody, McpConfigDocument } from './protocol'

export interface ControlServerDeps {
  handoff(input: {
    fromBotId: string
    conversationId: string
    toBotName: string
    message: string
  }): Promise<{ ok: boolean; text: string }>
  groupHandoff(input: {
    fromBotId: string
    conversationId: string
    message: string
  }): Promise<{ ok: boolean; text: string }>
  listBots(input: { conversationId: string }): Promise<{ ok: boolean; text: string }>
}

interface ServerState {
  server: Server
  port: number
  deps: ControlServerDeps
}

let state: ServerState | null = null

/** Re-exported so the scheduler can append them to every job's `--allowedTools`. */
export { HANDOFF_TOOL_NAMES }

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function startControlServer(deps: ControlServerDeps): Promise<{ port: number }> {
  if (state) {
    // Idempotent: a second bootstrap (hot reload in dev) reuses the live server
    // but adopts the newest deps so it never points at a disposed scheduler.
    state.deps = deps
    return Promise.resolve({ port: state.port })
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      log.error('mcp', 'control request handler threw', err)
      writeJson(res, 500, { ok: false, text: 'Internal error in Claude Bot.' })
    })
  })

  // Keep-alive sockets from a dead bridge must not hold the port open at quit.
  server.keepAliveTimeout = 5_000
  server.headersTimeout = 10_000

  return new Promise<{ port: number }>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        reject(new Error('Control server did not report a port'))
        return
      }
      state = { server, port, deps }
      log.info('mcp', `handoff control server listening on 127.0.0.1:${port}`)
      resolve({ port })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    // Port 0 → the OS picks a free ephemeral port. Host is pinned to loopback.
    server.listen(0, '127.0.0.1')
  })
}

export function stopControlServer(): Promise<void> {
  const current = state
  state = null
  // Every outstanding credential dies with the listener.
  clearGrants()
  if (!current) return Promise.resolve()
  return new Promise<void>((resolve) => {
    // `close` waits for in-flight requests; `closeAllConnections` drops idle
    // keep-alive sockets so quit is not delayed by a bridge that never exits.
    current.server.closeAllConnections()
    current.server.close(() => resolve())
  })
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

function writeJson(res: ServerResponse, status: number, body: ControlResponseBody): void {
  // The socket may already be gone (client hung up mid-request); writing then
  // throws ERR_STREAM_WRITE_AFTER_END and takes down the request handler.
  if (res.writableEnded || res.destroyed) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    // Nothing here is cacheable and nothing here is for a browser.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(payload)
}

/** Loopback-only defence in depth: the listener is already bound to 127.0.0.1. */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * Point past which we stop being polite and cut the socket. An over-limit body
 * is drained rather than reset so the caller still receives a readable 413
 * (destroying the socket mid-request surfaces to the client as ECONNRESET, with
 * no explanation of what went wrong), but a client that keeps streaming does
 * not get to use us as free memory.
 */
const HARD_ABORT_BYTES = 4 * 1024 * 1024

type BodyResult = { ok: true; text: string } | { ok: false; status: number; reason: string }

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflowed = false
    let settled = false

    const finish = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10)
    if (Number.isFinite(declared) && declared > CONTROL_MAX_BODY_BYTES) {
      overflowed = true
    }

    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > CONTROL_MAX_BODY_BYTES) {
        overflowed = true
        // Release what we already buffered — it is never going to be parsed.
        chunks.length = 0
      } else {
        chunks.push(chunk)
      }
      if (total > HARD_ABORT_BYTES) {
        finish({ ok: false, status: 413, reason: 'Request body too large.' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (overflowed) {
        finish({ ok: false, status: 413, reason: 'Request body too large.' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () => {
      finish({ ok: false, status: 400, reason: 'Request aborted.' })
    })
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const current = state
  if (!current) {
    writeJson(res, 503, { ok: false, text: 'Claude Bot is shutting down.' })
    return
  }

  if (!isLoopback(req)) {
    log.warn('mcp', 'rejected non-loopback control request', { remote: req.socket.remoteAddress })
    writeJson(res, 403, { ok: false, text: 'Forbidden.' })
    return
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, text: 'Method not allowed.' })
    return
  }

  // `req.url` may carry a query string; only the path is meaningful.
  const path = (req.url ?? '').split('?', 1)[0]
  if (path !== CONTROL_RPC_PATH) {
    writeJson(res, 404, { ok: false, text: 'Not found.' })
    return
  }

  // The credential IS the identity: everything downstream acts as this grant's
  // Bot in this grant's conversation, whatever the body may claim.
  const grant = resolveGrant(req.headers['authorization'])
  if (!grant) {
    log.warn('mcp', 'rejected control request with a bad, missing or expired token')
    writeJson(res, 401, { ok: false, text: 'Unauthorized.' })
    return
  }

  const body = await readBody(req)
  if (!body.ok) {
    writeJson(res, body.status, { ok: false, text: body.reason })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    writeJson(res, 400, { ok: false, text: 'Malformed JSON body.' })
    return
  }

  const coerced = coerceRequest(parsed)
  if (!coerced.ok) {
    writeJson(res, 400, { ok: false, text: coerced.reason })
    return
  }
  const request = coerced.request

  // Everything past this point is a *tool* failure, not a transport failure:
  // answer 200 with `ok: false` so the model reads the reason instead of an
  // opaque HTTP error.
  try {
    const result = await dispatch(current.deps, request, grant)
    writeJson(res, 200, result)
  } catch (err) {
    log.error('mcp', `handoff tool "${request.tool}" failed`, err)
    writeJson(res, 200, {
      ok: false,
      text: err instanceof Error ? err.message : 'The request could not be completed.'
    })
  }
}

type CoerceResult =
  | { ok: true; request: ControlRequestBody }
  | { ok: false; reason: string }

/**
 * A caller may state a tool and its arguments and nothing else.
 *
 * `botId`/`conversationId` in the body are refused rather than ignored: silently
 * dropping them would let a bridge from an older build keep "working" while its
 * stated identity was quietly discarded, which is exactly the kind of mismatch
 * that hides a real problem. A loud 400 says the two halves are out of step.
 */
function coerceRequest(parsed: unknown): CoerceResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON object body.' }
  }
  const record = parsed as Record<string, unknown>
  if ('botId' in record || 'conversationId' in record) {
    return {
      ok: false,
      reason:
        'This request carried a botId or conversationId. Identity comes from the credential, not the body — the MCP bridge is out of date with the app.'
    }
  }
  const tool = record['tool']
  if (typeof tool !== 'string' || !tool) {
    return { ok: false, reason: 'Missing `tool`.' }
  }
  const rawArgs = record['arguments']
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}
  return { ok: true, request: { tool, arguments: args } }
}

/** Trim + length-guard a string argument. The bridge validates too; this is the trust boundary. */
function stringArg(args: Record<string, unknown>, key: string, maxLength: number): string | null {
  const raw = args[key]
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

async function dispatch(
  deps: ControlServerDeps,
  request: ControlRequestBody,
  grant: JobGrant
): Promise<ControlResponseBody> {
  switch (request.tool) {
    case HANDOFF_TOOL.sendToBot: {
      const toBotName = stringArg(request.arguments, 'bot_name', 200)
      const message = stringArg(request.arguments, 'message', 100_000)
      if (!toBotName) return { ok: false, text: '`bot_name` is required.' }
      if (!message) return { ok: false, text: '`message` is required.' }
      return deps.handoff({
        fromBotId: grant.botId,
        conversationId: grant.conversationId,
        toBotName,
        message
      })
    }

    case HANDOFF_TOOL.sendToGroup: {
      const message = stringArg(request.arguments, 'message', 100_000)
      if (!message) return { ok: false, text: '`message` is required.' }
      return deps.groupHandoff({
        fromBotId: grant.botId,
        conversationId: grant.conversationId,
        message
      })
    }

    case HANDOFF_TOOL.listBots: {
      return deps.listBots({ conversationId: grant.conversationId })
    }

    default:
      return { ok: false, text: `Unknown tool "${request.tool}".` }
  }
}

/* ------------------------------------------------------------------ *
 * --mcp-config generation
 * ------------------------------------------------------------------ */

/**
 * The `--mcp-config` document for one job, or `null` when handoffs are disabled
 * or the control server is not up.
 *
 * Every call mints a fresh 32-byte token and records it against this job's
 * identity. A job can run this document more than once — PRD §37 session
 * recovery retries the turn with the same input — so the runtime exchanges it
 * for an attempt-scoped credential via `mcpConfigForAttempt()` and hands THAT
 * back to `revokeMcpConfig()` when the process is reaped.
 *
 * The caller must NOT put this string on a command line — `ps` is readable by
 * every account on macOS and by every process on Linux, and this document
 * contains the token. `ClaudeCodeRuntime` writes it to a 0600 file and passes
 * the path; `--mcp-config` accepts either (verified against Claude Code 2.1.241:
 * "Load MCP servers from JSON files or strings"). Deliberately without
 * `--strict-mcp-config` so the user's own MCP servers stay available alongside
 * ours (ARCHITECTURE §0).
 *
 * The bridge is launched as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`
 * because a packaged app cannot assume a plain `node` binary exists on the
 * user's PATH, but Electron itself is always present.
 */
export function mcpConfigForJob(ctx: { botId: string; conversationId: string }): string | null {
  if (!state) return null

  let handoffsEnabled = true
  try {
    handoffsEnabled = settingsRepo.get().handoffsEnabled
  } catch (err) {
    // Settings live in SQLite; if that read fails we fail closed rather than
    // handing the model tools whose backing store is unhealthy.
    log.warn('mcp', 'could not read settings for mcp config; disabling handoffs for this turn', err)
    return null
  }
  if (!handoffsEnabled) return null

  let script: string
  try {
    script = bridgeScriptPath()
  } catch (err) {
    log.error('mcp', 'bridge script unavailable; handoffs disabled for this turn', err)
    return null
  }

  return documentFor(issueGrant(ctx), script)
}

/**
 * Exchange a job's document for one carrying a credential valid for the attempt
 * that is about to start, or `null` if it cannot be credentialled.
 *
 * Why this exists: `mcpConfigForJob()` is called once per JOB, but the credential
 * is retired once per ATTEMPT — the runtime revokes it when the turn's process is
 * reaped. A recovered turn (PRD §37) re-runs `runTurn` with the very same input,
 * so it used to present a token that had already been deleted and EVERY handoff
 * in it answered 401 `Unauthorized.`, with nothing in the log pointing at why.
 *
 * The common case — the first attempt, whose token is still live — returns the
 * document unchanged, so nothing is minted twice. A retry lands on the identity
 * kept by `retireGrant()` and gets a fresh token for the same Bot and
 * conversation. `handoffsEnabled` is deliberately NOT re-read here: whether a
 * handoff is permitted is decided by HandoffManager when the tool is actually
 * called, so a mid-turn toggle is still honoured without leaving the turn with
 * allowed tools whose server has vanished underneath them.
 */
export function mcpConfigForAttempt(configJson: string | null): string | null {
  if (!configJson) return null
  if (!state) return null

  const token = tokenFromConfig(configJson)
  if (!token) {
    log.warn('mcp', 'could not read a token out of an mcp config document; handoffs off')
    return null
  }
  if (isLiveGrant(token)) return configJson

  const identity = identityForToken(token)
  if (!identity) {
    // Fail closed: passing a document whose credential is dead would produce a
    // 401 on the first handoff instead of an honest "no handoffs this turn".
    log.warn('mcp', 'mcp config presented a credential we no longer know; handoffs off')
    return null
  }

  let script: string
  try {
    script = bridgeScriptPath()
  } catch (err) {
    log.error('mcp', 'bridge script unavailable; handoffs disabled for this turn', err)
    return null
  }
  log.info('mcp', 're-issued a handoff credential for a retried turn', {
    botId: identity.botId,
    conversationId: identity.conversationId
  })
  return documentFor(issueGrant(identity), script)
}

function documentFor(grant: JobGrant, script: string): string | null {
  if (!state) return null
  const doc: McpConfigDocument = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [script],
        env: {
          // Turns the Electron binary into a plain Node runtime.
          ELECTRON_RUN_AS_NODE: '1',
          [CONTROL_ENV.port]: String(state.port),
          [CONTROL_ENV.token]: grant.token
        }
      }
    }
  }
  return JSON.stringify(doc)
}

/**
 * Retire the credential in a document handed out by `mcpConfigForAttempt()`.
 *
 * Called when the turn's process has been reaped, so the window in which a
 * token read out of the config file is usable is the turn itself and no longer.
 * The identity behind it is kept briefly (see `grants.ts`) so a retried attempt
 * of the same turn can be re-credentialled. Safe to call twice, and with `null`.
 */
export function revokeMcpConfig(configJson: string | null): void {
  if (!configJson) return
  const token = tokenFromConfig(configJson)
  if (!token) {
    // Not fatal — the sweep in `grants.ts` still bounds the leak — but it means
    // the document and this function have drifted apart, which is worth knowing.
    log.warn('mcp', 'could not read a token out of an mcp config document; not revoked')
    return
  }
  retireGrant(token)
}

function tokenFromConfig(configJson: string): string | null {
  try {
    const doc = JSON.parse(configJson) as McpConfigDocument
    const token = doc?.mcpServers?.[MCP_SERVER_NAME]?.env?.[CONTROL_ENV.token]
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Bridge script resolution
 * ------------------------------------------------------------------ */

let resolvedBridgePath: string | null = null

/**
 * Absolute path to a bridge script the child process can actually execute.
 *
 * Two wrinkles are handled here:
 *
 *  1. **Entry file name.** electron-vite names main-process outputs `[name].js`
 *     from the rollup input key, so the `mcpBridge` entry lands as
 *     `mcpBridge.js`. We probe the plausible names rather than hard-coding one,
 *     so renaming the entry key cannot silently break handoffs.
 *  2. **asar.** In a packaged build the bundle lives inside `app.asar`. Electron's
 *     asar shim exists in the main process but not reliably in an
 *     `ELECTRON_RUN_AS_NODE` child, so when the script is inside an archive we
 *     materialise a real copy under `userData/` (alongside a `package.json`
 *     that pins the same module `type` the app package uses, otherwise Node
 *     would guess CommonJS and choke on the ESM output).
 */
export function bridgeScriptPath(): string {
  if (resolvedBridgePath) return resolvedBridgePath

  const appPath = app.getAppPath()
  // `getAppPath()` is the directory containing the entry point. Packaged and
  // `electron .` give the project/asar root, so the bridge is under out/main —
  // but launching the built entry directly (`electron out/main/index.js`, which
  // is what the dev harness does) already puts us IN out/main, and joining it
  // again produced out/main/out/main. That silently disabled handoffs for the
  // whole run with only a log line to show for it, so probe both.
  const outDirs = [join(appPath, 'out', 'main'), appPath]
  const candidates = ['mcp-bridge.js', 'mcpBridge.js', 'mcp-bridge.mjs', 'mcpBridge.mjs']

  let bundled: string | null = null
  for (const outDir of outDirs) {
    for (const name of candidates) {
      const candidate = join(outDir, name)
      if (existsSync(candidate)) {
        bundled = candidate
        break
      }
    }
    if (bundled) break
  }
  if (!bundled) {
    throw new Error(
      `MCP bridge script not found in ${outDirs.join(' or ')} (looked for ${candidates.join(', ')})`
    )
  }

  resolvedBridgePath = bundled.includes(`.asar${sep}`) ? materializeBridge(bundled, appPath) : bundled
  return resolvedBridgePath
}

/**
 * Copy the bridge out of the asar archive into a stable, real directory.
 * Rewritten only when the content actually changed, so an app update refreshes
 * it and a normal launch does no disk work.
 */
function materializeBridge(bundledPath: string, appPath: string): string {
  const source = readFileSync(bundledPath, 'utf8')
  const dir = join(app.getPath('userData'), 'mcp-bridge')
  mkdirSync(dir, { recursive: true })

  // Node decides ESM vs CJS from the nearest package.json. Outside the app
  // bundle there is none, so mirror the app's own `type` field.
  let moduleType = 'commonjs'
  try {
    const pkgRaw = readFileSync(join(appPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { type?: unknown }
    if (pkg.type === 'module') moduleType = 'module'
  } catch {
    // Fall through with the CommonJS default; the content probe below is a
    // second line of defence.
  }
  if (/^\s*(import|export)\s/m.test(source)) moduleType = 'module'

  const pkgPath = join(dir, 'package.json')
  const pkgBody = `${JSON.stringify({ name: 'claude-bot-mcp-bridge', private: true, type: moduleType }, null, 2)}\n`
  writeIfChanged(pkgPath, pkgBody)

  const scriptPath = join(dir, 'mcp-bridge.js')
  writeIfChanged(scriptPath, source)

  log.info('mcp', `materialized MCP bridge to ${scriptPath} (${moduleType})`)
  return scriptPath
}

function writeIfChanged(path: string, contents: string): void {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  } catch {
    // Unreadable target — fall through and overwrite it.
  }
  writeFileSync(path, contents, 'utf8')
}
