/**
 * Finds the user's `claude` executable and reports whether it is usable.
 *
 * Two environment realities drive everything in this file:
 *
 * 1. **A GUI-launched Electron app has almost no PATH.** Double-clicking the app from
 *    Finder gives the process `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Every plausible
 *    Claude Code install (npm global, native installer, Homebrew) lives outside that,
 *    so `which claude` would fail for a user whose Terminal works fine. We therefore
 *    ask the user's login shell for its real environment once per process.
 * 2. **`claude` is very often a shell function, not a binary.** A common dotfile is
 *    `claude() { command claude --dangerously-skip-permissions "$@"; }`. Asking a shell
 *    to resolve the name then yields a function body (or just the bare word `claude`),
 *    which is not a path. Every candidate is therefore validated as an absolute path to
 *    an existing executable file before we will spawn it.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { log } from '@main/lib/logger'

export interface DetectResult {
  path: string | null
  version: string | null
  detail: string | null
  /** true when the binary exists and reports a version. */
  ok: boolean
}

const SHELL_ENV_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 5000
const AUTH_TIMEOUT_MS = 8000

/** Unique fences so we can lift the env block out of any shell banner or MOTD noise. */
const ENV_BEGIN = '__CCB_ENV_BEGIN__'
const ENV_END = '__CCB_ENV_END__'

const IS_WINDOWS = process.platform === 'win32'
const EXECUTABLE_NAME = IS_WINDOWS ? 'claude.cmd' : 'claude'

/* ------------------------------------------------------------------ *
 * Login-shell environment
 * ------------------------------------------------------------------ */

let shellEnvPromise: Promise<NodeJS.ProcessEnv> | null = null

/**
 * Resolve the user's real login-shell environment (mainly PATH). Cached for the life of
 * the process; falls back to `process.env` on any failure or timeout so a broken
 * dotfile can never stop the app from starting.
 */
export function resolveShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (!shellEnvPromise) shellEnvPromise = loadShellEnv()
  return shellEnvPromise
}

async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  // Windows processes inherit the full user environment already.
  if (IS_WINDOWS) return { ...process.env }

  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh'
  const shellName = path.basename(shell)
  const script = `printf '%s\\n' ${ENV_BEGIN}; printenv; printf '%s\\n' ${ENV_END}`
  // `-i` makes zsh/bash read the interactive rc files where PATH is usually extended;
  // `-l` picks up the login profile. fish rejects the combined `-lic` form.
  const args = shellName === 'fish' ? ['-l', '-c', script] : ['-lic', script]

  try {
    const { stdout } = await runCapture(shell, args, {
      timeoutMs: SHELL_ENV_TIMEOUT_MS,
      env: process.env,
      cwd: homedir()
    })
    const parsed = parseEnvBlock(stdout)
    if (!parsed) {
      log.warn('detector', 'login shell produced no environment block; using process env')
      return { ...process.env }
    }
    // process.env is the base so Electron-specific variables survive; the shell wins
    // for everything it actually defines (PATH, NVM_*, language toolchain shims).
    return withIdentity({ ...process.env, ...parsed })
  } catch (error) {
    log.warn('detector', 'failed to resolve login shell environment', {
      shell,
      message: error instanceof Error ? error.message : String(error)
    })
    return withIdentity({ ...process.env })
  }
}

/**
 * Guarantee USER / LOGNAME / HOME.
 *
 * Measured: `claude auth status` returns `loggedIn: false` when `USER` is absent
 * — it cannot reach the macOS keychain entry without it — and a login shell does
 * not export `USER` if its own parent never set it. That combination made an app
 * launched with a thin environment report a perfectly signed-in user as
 * "not signed in", which is the single most alarming thing this app can say
 * incorrectly. `os.userInfo()` reads the OS directly, so it is right regardless
 * of how the app was started.
 */
function withIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    const info = userInfo()
    if (!env.USER && info.username) env.USER = info.username
    if (!env.LOGNAME && info.username) env.LOGNAME = info.username
    if (!env.HOME && info.homedir) env.HOME = info.homedir
  } catch {
    // userInfo() throws when there is no matching passwd entry. Nothing to add.
  }
  return env
}

/**
 * Extract the fenced `printenv` output. Values may legitimately contain newlines, so a
 * line only starts a new variable when it looks like `NAME=`; anything else is a
 * continuation of the previous value.
 */
function parseEnvBlock(stdout: string): NodeJS.ProcessEnv | null {
  const begin = stdout.indexOf(ENV_BEGIN)
  const end = stdout.indexOf(ENV_END, begin + 1)
  if (begin === -1 || end === -1) return null

  const block = stdout.slice(begin + ENV_BEGIN.length, end)
  const env: NodeJS.ProcessEnv = {}
  let currentKey: string | null = null

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match) {
      currentKey = match[1]!
      env[currentKey] = match[2]!
    } else if (currentKey) {
      env[currentKey] = `${env[currentKey] ?? ''}\n${line}`
    }
  }

  return Object.keys(env).length > 0 ? env : null
}

/* ------------------------------------------------------------------ *
 * Executable detection
 * ------------------------------------------------------------------ */

/**
 * Locate the `claude` executable.
 *
 * Order: explicit override (the Settings field) → PATH scan under the resolved login
 * shell environment → the login shell's own `command -v` → well-known install
 * locations → the npm global bin directory.
 */
export async function detectClaude(override?: string | null): Promise<DetectResult> {
  const env = await resolveShellEnv()
  const attempted: string[] = []

  const trimmedOverride = override?.trim()
  if (trimmedOverride) {
    const resolved = validateExecutable(trimmedOverride)
    if (resolved) return finish(resolved)
    attempted.push(trimmedOverride)
    log.warn('detector', 'configured Claude path is not an executable file', {
      path: trimmedOverride
    })
  }

  const onPath = whichInPath(EXECUTABLE_NAME, env)
  if (onPath) return finish(onPath)

  const fromShell = await shellCommandV(env)
  if (fromShell) return finish(fromShell)

  for (const candidate of wellKnownLocations()) {
    const resolved = validateExecutable(candidate)
    if (resolved) return finish(resolved)
    attempted.push(candidate)
  }

  const npmBin = await npmGlobalBin(env)
  if (npmBin) {
    const candidate = path.join(npmBin, EXECUTABLE_NAME)
    const resolved = validateExecutable(candidate)
    if (resolved) return finish(resolved)
    attempted.push(candidate)
  }

  const searchedPath = env.PATH ?? env.Path ?? '(empty)'
  return {
    path: null,
    version: null,
    ok: false,
    detail: `Could not find a "claude" executable.\nPATH searched: ${searchedPath}\nAlso checked: ${attempted.join(', ') || '(none)'}`
  }
}

async function finish(execPath: string): Promise<DetectResult> {
  const version = await claudeVersion(execPath)
  if (version) return { path: execPath, version, detail: null, ok: true }
  return {
    path: execPath,
    version: null,
    ok: false,
    detail: `Found ${execPath} but it did not respond to "claude --version".`
  }
}

/**
 * Reject anything that is not an absolute path to an existing executable file. This is
 * the guard that keeps a shell *function* named `claude` from being treated as a path.
 */
function validateExecutable(candidate: string): string | null {
  if (!candidate) return null
  // A function body or an alias expansion contains whitespace/newlines and braces; a
  // real path from `command -v` never does.
  if (/[\n\r]/.test(candidate)) return null
  if (!path.isAbsolute(candidate)) return null

  try {
    // statSync follows symlinks, which is what we want: ~/.local/bin/claude is a link
    // into ~/.local/share/claude/versions/<v>.
    const stats = statSync(candidate)
    if (!stats.isFile()) return null
    accessSync(candidate, constants.X_OK)
    return candidate
  } catch {
    return null
  }
}

/**
 * Why a manually configured `claude` path could never work, or null if it looks
 * usable. The message is written for the person who typed the path.
 *
 * Shared by every channel that writes `settings.claudeExecutablePath` so the two
 * cannot disagree about what is acceptable: `runtime:pickExecutable` has always
 * stat'ed its pick, while `settings:update` took any string, persisted it, and
 * then had it silently ignored by `validateExecutable` above — leaving the user
 * with a green "Claude Code · ok" badge for a path the app was not using.
 */
export function explainUnusableExecutable(candidate: string): string | null {
  const value = candidate.trim()
  if (!value) return null // Empty means "go back to auto-detection".
  if (/[\n\r]/.test(value)) return 'That does not look like a file path.'
  if (!path.isAbsolute(value)) {
    return 'Use the full path to the claude executable, starting at the root of the disk.'
  }

  let stats: ReturnType<typeof statSync>
  try {
    // Follows symlinks, matching `validateExecutable`: ~/.local/bin/claude is a
    // link into ~/.local/share/claude/versions/<v>.
    stats = statSync(value)
  } catch {
    return 'There is nothing at that path.'
  }
  if (stats.isDirectory()) return 'That is a folder, not the claude executable.'
  if (!stats.isFile()) return 'That is not a file.'
  // 0o111 = any execute bit. Skipped on Windows, where it means nothing: libuv's
  // access() only fails X_OK for read-only files, so the test would pass for any
  // file at all and reject every ordinary .cmd shim for no reason.
  if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) {
    return 'That file is not executable.'
  }
  return null
}

/** A PATH scan done in Node, so no shell gets the chance to resolve a function. */
function whichInPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const rawPath = env.PATH ?? env.Path ?? ''
  if (!rawPath) return null

  const extensions = IS_WINDOWS
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']

  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue
    const base = path.join(dir, IS_WINDOWS ? 'claude' : name)
    for (const ext of extensions) {
      const resolved = validateExecutable(base + ext)
      if (resolved) return resolved
    }
  }
  return null
}

/**
 * Last-resort shell probe. `command -v` is used rather than `which` because `which` in
 * an interactive zsh prints the whole function body. Even so, the result is only
 * accepted when it validates as an absolute executable path - for a shell function
 * `command -v` prints the bare word `claude`, which this correctly discards.
 */
async function shellCommandV(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (IS_WINDOWS) return null
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh'
  const shellName = path.basename(shell)
  const script = `command -v ${EXECUTABLE_NAME} 2>/dev/null`
  const args = shellName === 'fish' ? ['-l', '-c', script] : ['-lic', script]

  try {
    const { stdout } = await runCapture(shell, args, {
      timeoutMs: SHELL_ENV_TIMEOUT_MS,
      env,
      cwd: homedir()
    })
    for (const line of stdout.split('\n')) {
      const resolved = validateExecutable(line.trim())
      if (resolved) return resolved
    }
  } catch (error) {
    log.debug('detector', 'shell command -v probe failed', { message: String(error) })
  }
  return null
}

function wellKnownLocations(): string[] {
  const home = homedir()
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA
    return [
      appData ? path.join(appData, 'npm', 'claude.cmd') : '',
      path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe')
    ].filter(Boolean)
  }
  return [
    // Native installer (the shape shipped with Claude Code 2.x).
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    // Homebrew on Apple Silicon, then Intel / manual installs.
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ]
}

/** `npm prefix -g` + `/bin`. Only consulted when every cheaper lookup failed. */
async function npmGlobalBin(env: NodeJS.ProcessEnv): Promise<string | null> {
  const npm = whichInPath(IS_WINDOWS ? 'npm.cmd' : 'npm', env)
  if (!npm) return null
  try {
    const { stdout } = await runCapture(npm, ['prefix', '-g'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env,
      cwd: homedir()
    })
    const prefix = stdout.trim().split('\n').pop()?.trim()
    if (!prefix || !path.isAbsolute(prefix)) return null
    return IS_WINDOWS ? prefix : path.join(prefix, 'bin')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Version + auth probes
 * ------------------------------------------------------------------ */

/** `claude --version`, 5s timeout. Returns the version string or null. */
export async function claudeVersion(execPath: string): Promise<string | null> {
  try {
    const env = await resolveShellEnv()
    const { stdout, stderr, code } = await runCapture(execPath, ['--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env,
      cwd: homedir()
    })
    if (code !== 0 && !stdout.trim()) {
      log.warn('detector', 'claude --version failed', { code, stderr: stderr.slice(0, 400) })
      return null
    }
    // Output looks like "2.1.241 (Claude Code)": the version is the FIRST thing
    // printed, so anchor to it. Searching anywhere in stdout accepted any program
    // that happens to print a dotted number — `/bin/sh --version` prints "GNU
    // bash, version 3.2.57(1)-release", which matched, so pointing the app at the
    // wrong binary produced a healthy "Claude Code · ok" badge and garbage turns
    // instead of an error naming the path.
    const firstLine = stdout.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
    const match = /^\d+\.\d+\.\d+[^\s]*/.exec(firstLine)
    if (!match) {
      log.warn('detector', 'claude --version did not print a version', {
        execPath,
        output: stdout.slice(0, 200)
      })
      return null
    }
    return match[0]
  } catch (error) {
    log.warn('detector', 'claude --version threw', { message: String(error) })
    return null
  }
}

/** Signals in CLI output that unambiguously mean "you are not signed in". */
const UNAUTHENTICATED_PATTERNS = [
  'not logged in',
  'not authenticated',
  'unauthenticated',
  'please log in',
  'please run /login',
  'run `claude login`',
  'claude setup-token',
  'setup-token',
  'invalid api key',
  'authentication_error',
  'oauth token has expired',
  'credentials not found'
]

/**
 * Cheap authentication probe.
 *
 * Hard requirement: this must never consume model quota, so it never sends a prompt.
 * `claude auth status` prints `{"loggedIn":true,...}` on recent builds; older builds
 * do not have the subcommand, in which case we fall back to `claude doctor` and then to
 * on-disk credential evidence.
 *
 * When the answer is genuinely unknowable we report `authenticated: true` with a detail
 * string saying so. A false "not logged in" screen blocks a working install, whereas an
 * optimistic answer costs the user one turn that surfaces the real error.
 */
export async function checkAuth(
  execPath: string
): Promise<{ authenticated: boolean; detail: string | null }> {
  const env = await resolveShellEnv()

  // 1. The definitive answer, when this build supports it.
  const status = await tryAuthStatus(execPath, env)
  if (status) return status

  // 2. `claude doctor` is quota-free and prints installation health.
  const doctor = await tryDoctor(execPath, env)
  if (doctor) return doctor

  // 3. No CLI signal: look for stored credentials.
  const evidence = await credentialEvidence(env)
  if (evidence) return { authenticated: true, detail: evidence }

  return {
    authenticated: true,
    detail:
      'Could not verify Claude Code authentication (unverified). If a turn fails with a login error, run `claude` in Terminal and sign in.'
  }
}

async function tryAuthStatus(
  execPath: string,
  env: NodeJS.ProcessEnv
): Promise<{ authenticated: boolean; detail: string | null } | null> {
  try {
    const { stdout } = await runCapture(execPath, ['auth', 'status'], {
      timeoutMs: AUTH_TIMEOUT_MS,
      env,
      cwd: homedir()
    })
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    if (start === -1 || end <= start) return null

    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.loggedIn !== 'boolean') return null

    if (!record.loggedIn) {
      return { authenticated: false, detail: 'Claude Code reports that you are not signed in.' }
    }
    const account = typeof record.email === 'string' ? record.email : null
    const plan = typeof record.subscriptionType === 'string' ? record.subscriptionType : null
    const parts = [account, plan ? `${plan} plan` : null].filter((p): p is string => p !== null)
    return {
      authenticated: true,
      detail: parts.length > 0 ? `Signed in — ${parts.join(' · ')}` : 'Signed in.'
    }
  } catch (error) {
    // Older builds exit non-zero with "unknown command 'auth'". Not an auth signal.
    log.debug('detector', 'claude auth status unavailable', { message: String(error) })
    return null
  }
}

async function tryDoctor(
  execPath: string,
  env: NodeJS.ProcessEnv
): Promise<{ authenticated: boolean; detail: string | null } | null> {
  try {
    const { stdout, stderr } = await runCapture(execPath, ['doctor'], {
      timeoutMs: AUTH_TIMEOUT_MS,
      env,
      cwd: homedir()
    })
    const haystack = `${stdout}\n${stderr}`.toLowerCase()
    const hit = UNAUTHENTICATED_PATTERNS.find((pattern) => haystack.includes(pattern))
    if (hit) {
      return {
        authenticated: false,
        detail: `Claude Code reported an authentication problem (matched "${hit}").`
      }
    }
    return null
  } catch (error) {
    log.debug('detector', 'claude doctor probe failed', { message: String(error) })
    return null
  }
}

/**
 * Look for stored credentials without ever reading their contents beyond existence.
 * The app must not capture the user's tokens (PRD section 6.2) - we only want to know
 * whether Claude Code has been through a login at least once.
 */
async function credentialEvidence(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) {
    return 'Using ANTHROPIC_API_KEY from your environment.'
  }

  const home = homedir()
  try {
    await stat(path.join(home, '.claude', '.credentials.json'))
    return 'Found stored Claude Code credentials.'
  } catch {
    /* not present: keep looking */
  }

  // There used to be a second branch here that read the whole of
  // `~/.claude.json` looking for an `"oauthAccount"` key. It is gone, and the
  // promise in the comment above is why: that file is the app's own documented
  // "juicy target" (see window.ts — 181KB including the account), and on a real
  // machine it also holds third-party MCP server API keys. Pulling all of it
  // into main-process memory bought one nicer sentence on a screen that is
  // already reachable only on a CLI too old to have `claude auth status`, and
  // where falling through reports `authenticated: true` anyway. Bounding the
  // read is not a fix: `"oauthAccount"` is serialised AFTER the project history,
  // 96% of the way into the file, so a prefix read would silently find nothing.
  return null
}

/* ------------------------------------------------------------------ *
 * Small capture helper
 * ------------------------------------------------------------------ */

interface CaptureResult {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * Run a short-lived probe and capture its output. Deliberately separate from
 * `spawnCli`: probes need a timeout and a combined result, turns need streaming.
 */
function runCapture(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd: string }
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let done = false

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      reject(new Error(`timed out after ${opts.timeoutMs}ms: ${command} ${args.join(' ')}`))
    }, opts.timeoutMs)
    timer.unref()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}
