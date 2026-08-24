/**
 * The single place in the app that starts a child process.
 *
 * Everything here follows PRD section 27.1: `spawn` with `shell: false`, an argument
 * array, an explicit cwd, and no string concatenation of user content into a command
 * line. A prompt can be tens of kilobytes of arbitrary text - it goes down stdin.
 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { log } from '@main/lib/logger'

/** Keep the FIRST 64KB of stderr: the real error is at the top, the tail is noise. */
const MAX_STDERR_BYTES = 64 * 1024

/** Default grace period between SIGTERM and SIGKILL. */
const DEFAULT_GRACE_MS = 4000

const IS_WINDOWS = process.platform === 'win32'

/**
 * POSIX only. `detached: true` puts the child in its own process group so that
 * `process.kill(-pid, ...)` reaches Claude *and* every tool it spawned. Without it a
 * cancelled turn leaves an orphaned `npm test` running forever.
 *
 * Windows has no process group that `process.kill(-pid, ...)` can address, so
 * `detached` buys nothing there (`windowsHide` already suppresses the console) and the
 * tree has to be walked externally instead - see `killWindowsTree`. The old fallback
 * here was a plain `child.kill()`, which reaches ONLY `claude.exe`: everything Claude
 * had spawned (a dev server, `npm test`, a long build) survived Stop and app quit with
 * no owner and no trace in the UI.
 */
const USE_PROCESS_GROUP = !IS_WINDOWS

/**
 * Windows tree kill, as prescribed by DESIGN.md section 5.7.
 *
 * `/F` is on the first and only attempt on purpose. Without it `taskkill` posts
 * WM_CLOSE to top-level windows, and a console process spawned with `windowsHide`
 * has no window to receive one - the call just fails with "can only be terminated
 * forcefully", so staging a graceful phase would burn the grace period achieving
 * nothing. Node maps SIGTERM to TerminateProcess on Windows anyway, so there is no
 * graceful signal to stage in the first place.
 */
function killWindowsTree(pid: number): void {
  const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  killer.on('exit', (code) => {
    // 128 is taskkill's "process not found" - this path's ESRCH. The child died on
    // its own between the liveness check and the call, which is routine.
    if (code !== 0 && code !== 128) log.debug('process', 'taskkill failed', { pid, code })
  })
  killer.on('error', (error) => {
    log.debug('process', 'taskkill could not start', { pid, message: String(error) })
  })
}

export interface SpawnHandle {
  pid: number | null
  /** UTF-8 decoded stdout chunks. Iterate to completion, or `kill()` to stop early. */
  stdout: AsyncIterable<string>
  /** Accumulated stderr so far, capped at 64KB. Safe to call at any time. */
  stderrText(): string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /**
   * POSIX: SIGTERM the process group, then SIGKILL after `graceMs`. Windows: one
   * `taskkill /T /F` on the whole tree, with `graceMs` ignored because no signal
   * there is graceful. Either way, resolves once the child itself is dead.
   */
  kill(graceMs?: number): Promise<void>
}

export interface SpawnCliOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to stdin, which is then closed. Empty string still closes stdin. */
  stdinText: string
}

export function spawnCli(opts: SpawnCliOptions): SpawnHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    detached: USE_PROCESS_GROUP,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams

  let stderrBuffer = ''
  /**
   * Byte length of `stderrBuffer`, carried forward instead of re-derived. The old
   * code called `Buffer.byteLength` on the whole buffer once per chunk AND once per
   * trimmed character, so one 64KB chunk arriving on a nearly-full buffer spun for
   * ~85ms (~770ms when the text was 3-byte UTF-8) inside the stderr 'data' handler -
   * on the Electron MAIN process, blocking IPC replies and stream deltas with it.
   */
  let stderrBytes = 0
  let stderrTruncated = false
  let settled = false
  let processExited = false
  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
  let resolveGone: () => void = () => {}

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve
  })

  /**
   * Resolves on 'exit' - the process is dead - **without** waiting for stdio to drain.
   *
   * This distinction is what makes `kill()` safe to call from inside the loop that is
   * consuming `stdout`. 'close' only fires once the pipes are fully read, so a consumer
   * that awaits `kill()` in its loop body would deadlock: it is not reading, so the
   * pipes never drain, so 'close' never fires, so `kill()` never resolves.
   */
  const processGone = new Promise<void>((resolve) => {
    resolveGone = resolve
  })

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    processExited = true
    resolveGone()
    if (settled) return
    settled = true
    resolveExit({ code, signal })
  }

  child.on('exit', () => {
    processExited = true
    resolveGone()
  })

  // 'close' rather than 'exit' for `exited`: it fires after all stdio streams are
  // drained, so the caller can read the last stdout chunk before we report the exit.
  child.on('close', (code, signal) => settle(code, signal))

  child.on('error', (error: NodeJS.ErrnoException) => {
    appendStderr(`spawn error: ${error.message}\n`)
    // A failed spawn (ENOENT/EACCES) never produces a pid and may never emit 'close'.
    if (child.pid === undefined) settle(null, null)
  })

  function appendStderr(text: string): void {
    if (stderrTruncated) return
    const remaining = MAX_STDERR_BYTES - stderrBytes
    if (remaining <= 0) {
      stderrTruncated = true
      return
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= remaining) {
      stderrBuffer += text
      stderrBytes += bytes
      return
    }
    // Trim on a character boundary; a raw byte slice could split a multi-byte
    // sequence. StringDecoder holds the trailing partial sequence back rather than
    // emitting a replacement character for it - which is also why `end()` is never
    // called here: that is exactly what flushes those held bytes as U+FFFD.
    const clipped = new StringDecoder('utf8').write(
      Buffer.from(text, 'utf8').subarray(0, remaining)
    )
    stderrBuffer += clipped
    stderrBytes += Buffer.byteLength(clipped, 'utf8')
    stderrTruncated = true
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => appendStderr(chunk))
  child.stderr.on('error', (error) => {
    log.debug('process', 'stderr stream error', { message: String(error) })
  })

  // Claude may finish and exit before it has drained a long prompt. That closes the
  // pipe under us and Node reports EPIPE on the write - an expected, harmless race.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return
    log.debug('process', 'stdin error', { code: error.code, message: error.message })
  })
  try {
    if (opts.stdinText) child.stdin.write(opts.stdinText)
    child.stdin.end()
  } catch (error) {
    log.debug('process', 'stdin write failed', { message: String(error) })
  }

  /** POSIX only - see `USE_PROCESS_GROUP` for why Windows takes another route. */
  const signalTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      // Negative pid targets the whole process group, killing Claude's own children.
      process.kill(-pid, signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // ESRCH: already gone. Anything else is worth a line in the diagnostics buffer.
      if (code !== 'ESRCH') log.debug('process', 'signal failed', { signal, code })
      // The group may not exist while the child still does (very early failures).
      if (code === 'ESRCH') {
        try {
          child.kill(signal)
        } catch {
          /* already reaped */
        }
      }
    }
  }

  const handle: SpawnHandle = {
    pid: child.pid ?? null,
    stdout: decodeStream(child.stdout),
    stderrText: () => (stderrTruncated ? `${stderrBuffer}\n... stderr truncated ...` : stderrBuffer),
    exited,
    async kill(graceMs = DEFAULT_GRACE_MS): Promise<void> {
      if (processExited) return
      let timer: NodeJS.Timeout | null = null
      if (IS_WINDOWS) {
        // One forceful tree kill, no escalation timer: there is no graceful signal to
        // escalate FROM on Windows, so waiting `graceMs` would only delay the UI's
        // transition to `cancelled`.
        const pid = child.pid
        if (pid === undefined) child.kill()
        else killWindowsTree(pid)
      } else {
        signalTree('SIGTERM')
        timer = setTimeout(() => signalTree('SIGKILL'), graceMs)
        // Do not hold the Electron event loop open purely for the escalation timer.
        timer.unref()
      }
      try {
        // `processGone`, not `exited`: see the comment on that promise. The caller may
        // still have unread stdout, and it must be able to drain it after we return.
        // Notably NOT taskkill's own exit either - the contract is "the child is dead",
        // and hanging this promise off an auxiliary process would reintroduce the
        // stdout-drain deadlock that `processGone` exists to avoid.
        await processGone
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
  }

  return handle
}

/**
 * Yield stdout as decoded strings. `setEncoding` installs a StringDecoder, so a
 * multi-byte UTF-8 character split across two OS reads is reassembled correctly
 * instead of arriving as replacement characters mid-JSON.
 */
async function* decodeStream(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding('utf8')
  // Node types the async iterator as `any`; with an encoding set the values really are
  // strings, and asserting that here keeps the cast out of every call site.
  for await (const chunk of stream as AsyncIterable<string>) {
    if (chunk.length > 0) yield chunk
  }
}
