/**
 * The Claude Code adapter: the only module that knows how to invoke the CLI.
 *
 * The invocation shape below is not a guess - it is the shape measured against Claude
 * Code 2.1.241 and recorded in ARCHITECTURE section 0. Two details are easy to get
 * wrong and fatal when you do:
 *
 *   - the prompt goes down **stdin**, never argv (`claude -p` with no prompt argument);
 *   - `--permission-mode` has no `default` member, so our `'default'` mode must omit
 *     the flag entirely. Passing the literal string aborts the process before a single
 *     token is produced.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RuntimeEvent } from '@shared/types/events'
import type { RuntimeStatus } from '@shared/types'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'
import { newId, nowIso } from '@main/lib/id'
import { userDataDir } from '@main/lib/paths'
import { settingsRepo } from '@main/db/repositories/settings'
import { mcpConfigForAttempt, revokeMcpConfig } from '@main/mcp/controlServer'
import type { AgentRuntime, RunTurnInput } from './types'
import { checkAuth, detectClaude, resolveShellEnv } from './ClaudeDetector'
import { spawnCli } from './ProcessManager'
import type { SpawnHandle } from './ProcessManager'
import { ClaudeStreamParser, SESSION_NOT_FOUND_MARKER } from './ClaudeStreamParser'

/** How long an availability probe stays fresh (ARCHITECTURE section 3.6). */
const STATUS_TTL_MS = 60_000

/**
 * Safety net for the window between "stdout closed" and "process reaped". A grandchild
 * that inherited the pipes can keep the entry alive; we would rather finalize the
 * message than leave a job spinning forever.
 */
const EXIT_GRACE_MS = 15_000

type ResultEvent = Extract<RuntimeEvent, { type: 'result' }>

interface ActiveJob {
  jobId: string
  handle: SpawnHandle | null
  cancelled: boolean
  /** Resolves when the turn's generator has fully unwound and the process is gone. */
  done: Promise<void>
  markDone: () => void
}

/**
 * Build the argv for one turn. Exported because the flag rules are the single most
 * failure-prone part of the integration and deserve to be inspectable on their own.
 *
 * `mcpConfigPath` is a PATH, never the config JSON itself - see
 * `writeMcpConfigFile` below for why that distinction is load-bearing.
 */
export function buildClaudeArgs(input: RunTurnInput, mcpConfigPath: string | null): string[] {
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose']

  if (input.includePartialMessages) args.push('--include-partial-messages')
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)

  // 'default' means "whatever the user's own Claude Code is configured to do".
  if (input.model && input.model !== 'default') args.push('--model', input.model)
  if (input.permissionMode && input.permissionMode !== 'default') {
    args.push('--permission-mode', input.permissionMode)
  }

  // A PATH, never the JSON. The document holds the control-server bearer token, and
  // an argv is not private: `/bin/ps` is setuid root on macOS and does no owner
  // filtering, and /proc/PID/cmdline is world-readable on Linux, so passing the JSON
  // inline published the token to every account on the machine. Deliberately without
  // --strict-mcp-config so the user's own MCP servers stay available alongside ours
  // (ARCHITECTURE section 0).
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)

  // Variadic flags go last: commander collects values until the next `-`-prefixed
  // token, so anything placed after them would be swallowed as a tool pattern.
  const allowed = cleanToolList(input.allowedTools)
  if (allowed.length > 0) args.push('--allowedTools', ...allowed)

  const disallowed = cleanToolList(input.disallowedTools)
  if (disallowed.length > 0) args.push('--disallowedTools', ...disallowed)

  return args
}

function cleanToolList(tools: string[] | undefined): string[] {
  if (!Array.isArray(tools)) return []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (typeof tool !== 'string') continue
    const trimmed = tool.trim()
    // A leading '-' would be parsed as a flag and derail the whole command line.
    if (!trimmed || trimmed.startsWith('-')) continue
    seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Where per-turn `--mcp-config` documents live. One file per turn, unlinked when
 * the turn's process is reaped.
 */
function mcpConfigDir(): string {
  return join(userDataDir(), 'mcp-config')
}

/**
 * Write one turn's `--mcp-config` document somewhere only this user can read it,
 * and return the path.
 *
 * The document contains the control server's bearer token, which is why it must
 * not be handed to the CLI inline: process command lines are readable by other
 * accounts. 0600 does not hide it from other processes running AS the user -
 * nothing on a single-user OS can - but it closes the cross-account hole, and
 * the token is scoped to this one turn and revoked when the turn ends.
 *
 * The file is created O_EXCL and chmod'ed BEFORE the contents are written, so
 * there is no window in which the token sits on disk at the default umask.
 */
function writeMcpConfigFile(configJson: string): string {
  const dir = mcpConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweepStaleMcpConfigs(dir)

  const path = join(dir, `${newId('mcp')}.json`)
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
  writeFileSync(path, configJson, { encoding: 'utf8' })
  return path
}

function removeMcpConfigFile(path: string | null): void {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch (error) {
    log.warn('runtime', 'could not remove an mcp config file', { path, message: String(error) })
  }
}

let sweptStaleConfigs = false

/**
 * Anything already in this directory belongs to a previous run of the app - we
 * unlink our own on the way out - so a crash cannot leave a readable token
 * behind indefinitely. Runs once per process, on the first turn that needs it.
 */
function sweepStaleMcpConfigs(dir: string): void {
  if (sweptStaleConfigs) return
  sweptStaleConfigs = true
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('mcp_') && name.endsWith('.json')) rmSync(join(dir, name), { force: true })
    }
  } catch (error) {
    log.debug('runtime', 'could not sweep stale mcp config files', { message: String(error) })
  }
}

/**
 * Belt and braces for the log ring buffer. Nothing secret rides on argv any more
 * (the config is a path), but the path is noise nobody needs in a log line.
 */
function redactArgs(args: string[]): string[] {
  const out = [...args]
  const idx = out.indexOf('--mcp-config')
  if (idx !== -1 && idx + 1 < out.length) out[idx + 1] = '<mcp-config path>'
  return out
}

export class ClaudeCodeRuntime implements AgentRuntime {
  #status: RuntimeStatus | null = null
  #statusAt = 0
  #inflightStatus: Promise<RuntimeStatus> | null = null
  #jobs = new Map<string, ActiveJob>()

  /** Cached for 60s so the sidebar badge and every job start do not re-probe the CLI. */
  async checkAvailability(force = false): Promise<RuntimeStatus> {
    if (!force && this.#status && Date.now() - this.#statusAt < STATUS_TTL_MS) {
      return this.#status
    }
    // Coalesce: app boot fires availability checks from several places at once.
    if (this.#inflightStatus) return this.#inflightStatus

    this.#inflightStatus = this.#probeAvailability().finally(() => {
      this.#inflightStatus = null
    })
    return this.#inflightStatus
  }

  async #probeAvailability(): Promise<RuntimeStatus> {
    const checkedAt = nowIso()
    const detected = await detectClaude(readConfiguredPath())

    let status: RuntimeStatus
    if (!detected.path) {
      status = {
        availability: 'missing',
        executablePath: null,
        version: null,
        detail: detected.detail,
        checkedAt
      }
    } else if (!detected.ok) {
      status = {
        availability: 'error',
        executablePath: detected.path,
        version: detected.version,
        detail: detected.detail,
        checkedAt
      }
    } else {
      const auth = await checkAuth(detected.path)
      status = {
        availability: auth.authenticated ? 'ok' : 'unauthenticated',
        executablePath: detected.path,
        version: detected.version,
        detail: auth.detail,
        checkedAt
      }
    }

    this.#status = status
    this.#statusAt = Date.now()
    log.info('runtime', 'availability probe', {
      availability: status.availability,
      version: status.version,
      path: status.executablePath
    })
    return status
  }

  isRunning(jobId: string): boolean {
    return this.#jobs.has(jobId)
  }

  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    if (this.#jobs.has(input.jobId)) {
      throw new AppError('busy', `Job ${input.jobId} is already running.`)
    }

    let markDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    const job: ActiveJob = { jobId: input.jobId, handle: null, cancelled: false, done, markDone }
    // Registered before the generator is pulled so `cancel()` works even if the caller
    // has not started iterating yet.
    this.#jobs.set(input.jobId, job)

    return this.#execute(input, job)
  }

  async *#execute(input: RunTurnInput, job: ActiveJob): AsyncGenerator<RuntimeEvent> {
    // Declared out here so the `finally` can always unlink/revoke them, including
    // on the paths that throw before the process is ever spawned.
    let mcpConfigPath: string | null = null
    let mcpConfigJson: string | null = null
    try {
      // ONE credential per attempt, not per job. The scheduler mints a document
      // once for the job and re-runs this generator with the same input when a
      // session has to be recovered (PRD section 37) - and the failed attempt's
      // `finally` has already revoked the credential in it, so the recovered turn
      // used to present a dead token and every handoff came back 401. Exchanging
      // the document here returns it unchanged on the first attempt and mints a
      // fresh credential for the same Bot/conversation on a retry.
      mcpConfigJson = mcpConfigForAttempt(input.mcpConfigJson)

      const status = await this.checkAvailability()
      assertUsable(status)
      if (job.cancelled) return

      if (mcpConfigJson) {
        try {
          mcpConfigPath = writeMcpConfigFile(mcpConfigJson)
        } catch (error) {
          // A full or read-only disk must not cost the user their answer. The turn
          // runs without handoffs; the model may still call a handoff tool and get
          // a "server not found" back from the CLI, which is a far softer failure
          // than no reply at all. Deliberately NOT falling back to passing the
          // JSON inline - that is the leak this file exists to avoid.
          log.error('runtime', 'could not write the mcp config; handoffs off for this turn', error)
          mcpConfigPath = null
        }
      }
      const args = buildClaudeArgs(input, mcpConfigPath)
      const env = await buildTurnEnv()

      log.info('runtime', 'spawning turn', {
        jobId: input.jobId,
        cwd: input.cwd,
        resuming: Boolean(input.resumeSessionId),
        args: redactArgs(args)
      })

      const handle = spawnCli({
        command: status.executablePath as string,
        args,
        cwd: input.cwd,
        env,
        stdinText: input.prompt
      })
      job.handle = handle
      // A cancel that landed during spawn must not leave a live process behind.
      if (job.cancelled) void handle.kill()

      const parser = new ClaudeStreamParser()

      /**
       * The terminal `result` line is held back until stderr has settled. Claude writes
       * "No conversation found with session ID: ..." to stderr, and stdout/stderr are
       * separate pipes with no ordering guarantee - buffering for the few milliseconds
       * between the last stdout line and process exit lets us emit exactly one result
       * event carrying the correct subtype, instead of an error followed by a
       * correction the scheduler would have to reconcile.
       */
      let pendingResult: ResultEvent | null = null

      const forward = function* (events: RuntimeEvent[]): Generator<RuntimeEvent> {
        for (const event of events) {
          if (event.type === 'result') {
            // More than one terminal line should not happen; if it does, do not drop it.
            if (pendingResult) yield pendingResult
            pendingResult = event
            continue
          }
          yield event
        }
      }

      for await (const chunk of handle.stdout) {
        yield* forward(parser.push(chunk))
      }
      yield* forward(parser.flush())

      const exit = await awaitExit(handle)
      const stderr = handle.stderrText()
      const sessionGone = stderr.includes(SESSION_NOT_FOUND_MARKER)

      if (pendingResult) {
        const result: ResultEvent = pendingResult
        yield sessionGone && result.subtype !== 'session_not_found'
          ? { ...result, subtype: 'session_not_found', sessionId: null }
          : result
      } else if (sessionGone) {
        // The CLI died before writing a result line; synthesize one so the scheduler
        // still gets its recovery signal rather than a bare non-zero exit.
        yield sessionNotFoundResult()
      }

      if (stderr.trim().length > 0) yield { type: 'stderr', text: stderr }
      yield { type: 'exit', code: exit.code, signal: exit.signal }
    } finally {
      // Covers early `return()` on the iterator (the consumer broke out of its loop) as
      // well as a normal finish, where kill() is a no-op because the child is reaped.
      if (job.handle) {
        try {
          await job.handle.kill()
        } catch (error) {
          log.debug('runtime', 'cleanup kill failed', { message: String(error) })
        }
      }
      // Only now that the process is gone: take the config file away and revoke the
      // credential inside it, so a token read out of it during the turn is dead the
      // moment the turn is. Order matters - revoking while the CLI is still running
      // would break a handoff the model is in the middle of making.
      removeMcpConfigFile(mcpConfigPath)
      revokeMcpConfig(mcpConfigJson)
      this.#jobs.delete(input.jobId)
      job.markDone()
    }
  }

  /** Resolves once the process is actually dead (PRD section 22 "Stop"). */
  async cancel(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId)
    if (!job) return
    job.cancelled = true

    if (!job.handle) {
      // Nothing spawned yet: the generator will see `cancelled` and bail out. Release
      // any waiter immediately rather than blocking on a turn that will never start.
      this.#jobs.delete(jobId)
      job.markDone()
      return
    }

    log.info('runtime', 'cancelling turn', { jobId, pid: job.handle.pid })
    // Resolves once the process is dead. Deliberately NOT `await job.done`: the caller
    // is often the same task that is iterating `runTurn`, and waiting for the generator
    // to unwind would require that iteration to continue - a guaranteed deadlock. The
    // remaining buffered output still reaches the consumer, so partial text survives.
    await job.handle.kill()
  }

  /** Stop everything on quit so no Claude process outlives the app. */
  async dispose(): Promise<void> {
    await Promise.all([...this.#jobs.keys()].map((jobId) => this.cancel(jobId)))
  }
}

function assertUsable(status: RuntimeStatus): void {
  if (status.availability === 'missing' || !status.executablePath) {
    throw new AppError(
      'runtime_missing',
      'Claude Code was not found on this computer.',
      status.detail ?? undefined
    )
  }
  if (status.availability === 'unauthenticated') {
    throw new AppError(
      'runtime_unauthenticated',
      'Claude Code is not signed in. Open Claude Code in Terminal, sign in, then try again.',
      status.detail ?? undefined
    )
  }
  if (status.availability === 'error') {
    throw new AppError(
      'runtime_missing',
      'Claude Code was found but is not responding.',
      status.detail ?? undefined
    )
  }
}

function sessionNotFoundResult(): ResultEvent {
  return {
    type: 'result',
    isError: true,
    subtype: 'session_not_found',
    resultText: null,
    sessionId: null,
    usage: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    model: null,
    permissionDenials: []
  }
}

async function awaitExit(
  handle: SpawnHandle
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    timer = setTimeout(() => resolve({ code: null, signal: null }), EXIT_GRACE_MS)
    timer.unref()
  })
  try {
    return await Promise.race([handle.exited, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function buildTurnEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...(await resolveShellEnv()) }

  // Electron sets this for its own node-mode children (the MCP bridge). Inheriting it
  // would make a node-based `claude` shim run as plain node and do nothing.
  delete env.ELECTRON_RUN_AS_NODE

  // A debug-mode Electron propagates inspector flags, and the child would then fight
  // for the same debug port. Strip only those, keep the user's other NODE_OPTIONS.
  if (env.NODE_OPTIONS) {
    const cleaned = env.NODE_OPTIONS.split(/\s+/)
      .filter((flag) => !flag.startsWith('--inspect'))
      .join(' ')
      .trim()
    if (cleaned) env.NODE_OPTIONS = cleaned
    else delete env.NODE_OPTIONS
  }

  // Keeps ANSI escapes out of the stderr we capture for diagnostics.
  env.NO_COLOR = '1'

  return env
}

/**
 * The manual executable path from Settings. Read defensively: availability can be
 * probed before the database is open, and a missing setting must degrade to
 * auto-detection rather than break the runtime status screen.
 */
function readConfiguredPath(): string | null {
  try {
    return settingsRepo.get().claudeExecutablePath ?? null
  } catch (error) {
    log.debug('runtime', 'settings unavailable while detecting Claude', {
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

let singleton: ClaudeCodeRuntime | null = null

/** Process-wide singleton; the availability cache and job table must be shared. */
export function getRuntime(): ClaudeCodeRuntime {
  if (!singleton) singleton = new ClaudeCodeRuntime()
  return singleton
}
