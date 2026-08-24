/**
 * A thin façade over the Claude Code runtime adapter for everything outside the
 * job scheduler.
 *
 * Two jobs only:
 *   1. hold the last known `RuntimeStatus` so `runtime:status` can be answered
 *      synchronously (the renderer asks for it during bootstrap, and a health
 *      probe can take a second or two — see ClaudeDetector's login-shell PATH
 *      resolution), and broadcast every change as a `runtime:status` event;
 *   2. open a real Terminal window for `claude` so an unauthenticated user can
 *      sign in (PRD 37 — "Claude not authenticated: explain and open terminal").
 *      We never try to perform the login ourselves: the credentials belong to
 *      the user's Claude Code install, not to this app (PRD 38.2).
 */
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:process'

import type { RuntimeStatus } from '@shared/types'
import { emit } from '@main/events'
import { AppError } from '@main/lib/errors'
import { nowIso } from '@main/lib/id'
import { log } from '@main/lib/logger'
import { userDataDir } from '@main/lib/paths'
import { getRuntime } from '@main/runtime/ClaudeCodeRuntime'

const LOGIN_SCRIPT_FILE = 'open-claude-login.command'
const WINDOWS_LOGIN_SCRIPT_FILE = 'open-claude-login.cmd'

let cached: RuntimeStatus = {
  availability: 'checking',
  executablePath: null,
  version: null,
  detail: null,
  checkedAt: nowIso()
}

/** De-duplicates concurrent checks: onboarding + settings can both ask at once. */
let inflight: Promise<RuntimeStatus> | null = null

/** Last known status. Never blocks; returns `checking` until the first probe lands. */
export function getStatus(): RuntimeStatus {
  return cached
}

export function refresh(force = false): Promise<RuntimeStatus> {
  if (inflight && !force) return inflight

  const run = getRuntime()
    .checkAvailability(force)
    .then((status) => {
      cached = status
      emit('runtime:status', status)
      log.info('runtime', `claude ${status.availability}`, {
        path: status.executablePath,
        version: status.version
      })
      return status
    })
    .catch((err: unknown) => {
      // A failed probe is itself a status, not an exception the UI has to handle.
      const status: RuntimeStatus = {
        availability: 'error',
        executablePath: cached.executablePath,
        version: cached.version,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: nowIso()
      }
      cached = status
      emit('runtime:status', status)
      log.error('runtime', 'availability check failed', err)
      return status
    })
    .finally(() => {
      if (inflight === run) inflight = null
    })

  inflight = run
  return run
}

/**
 * Kick off the first probe. Bootstrap must NOT await this: detection shells out
 * to the user's login shell to recover the real PATH, which is slow enough to be
 * visible as a hang on app launch.
 */
export function initialize(): void {
  void refresh(true)
}

function quoteForShell(value: string): string {
  // POSIX single-quote escaping: the only character that needs care is `'`.
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a path for a Windows batch file.
 *
 * A `.cmd` is itself a parser, so the value still has to be neutralised there:
 * double quotes take care of `&`, `|`, `^`, `(` and spaces (a Windows filename
 * cannot contain `"`), and `%` is doubled so a directory literally named
 * `%USERPROFILE%` cannot be expanded into something else.
 */
function quoteForBatch(value: string): string {
  return `"${value.replace(/%/g, '%%')}"`
}

function spawnDetached(
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    // shell:false + argv array, so Node never builds a command string for a shell
    // to re-parse (PRD 27.1 / 38.5). NOTE the one thing this does not buy: if the
    // command IS a shell, its own argv is a command line again. `cmd.exe /c start
    // … cmd /k <x>` re-parses `<x>`, and libuv quotes an argument only when it
    // contains whitespace — so `C:\Tools\R&D\claude.cmd` would arrive unquoted and
    // the `&` would start a second command. Everything handed to cmd below is a
    // compile-time constant; user-supplied values travel by `cwd` or inside a
    // quoted line in the helper script.
    const child = spawn(command, args, { detached: true, stdio: 'ignore', ...options })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Opens a terminal running the user's `claude` binary so they can complete
 * `/login`. Returns once the terminal has been launched, not once login is done.
 */
export async function openLoginTerminal(): Promise<void> {
  const status = cached.executablePath ? cached : await refresh()
  // Falling back to the bare name is correct: the terminal we open runs the
  // user's login shell, which has their real PATH even when this GUI app does not.
  const executable = status.executablePath ?? 'claude'

  if (platform === 'darwin') {
    const scriptPath = join(userDataDir(), LOGIN_SCRIPT_FILE)
    const script = [
      '#!/bin/sh',
      '# Written by Claude Bot to open an interactive Claude Code session.',
      'echo "Claude Bot — sign in to Claude Code in this window."',
      'echo "If you are not prompted automatically, type /login and press return."',
      'echo ""',
      `exec ${quoteForShell(executable)}`,
      ''
    ].join('\n')
    try {
      writeFileSync(scriptPath, script, 'utf8')
      chmodSync(scriptPath, 0o755)
    } catch (err) {
      throw new AppError('io', 'Could not prepare the Terminal helper script.', String(err))
    }
    // `.command` files run in Terminal; the path is passed as its own argv entry.
    await spawnDetached('open', ['-a', 'Terminal', scriptPath])
    return
  }

  if (platform === 'win32') {
    // Same shape as the macOS branch, and for the same reason: the executable
    // path is written into a helper script instead of being handed to cmd.exe's
    // parser. It used to be passed as `cmd /k <executable>`, where cmd re-parses
    // the tail — an install under `C:\Users\R&D\AppData\Roaming\npm\claude.cmd`
    // (no spaces, so libuv does not quote it) both failed to launch and ran
    // whatever followed the `&`. The only tokens cmd sees now are constants, and
    // the directory — which can itself contain `&` via the account name — is set
    // through `cwd`, exactly as ipc/system.ts does for "Open in Terminal".
    const scriptPath = join(userDataDir(), WINDOWS_LOGIN_SCRIPT_FILE)
    const script = [
      '@echo off',
      'rem Written by Claude Bot to open an interactive Claude Code session.',
      'echo Claude Bot - sign in to Claude Code in this window.',
      'echo If you are not prompted automatically, type /login and press return.',
      'echo.',
      // `call`, because `claude` is normally a .cmd shim: without it control never
      // returns and the window closes on some shells.
      `call ${quoteForBatch(executable)}`,
      ''
    ].join('\r\n')
    try {
      writeFileSync(scriptPath, script, 'utf8')
    } catch (err) {
      throw new AppError('io', 'Could not prepare the Terminal helper script.', String(err))
    }
    await spawnDetached(
      'cmd.exe',
      ['/c', 'start', 'Claude Code', 'cmd', '/k', WINDOWS_LOGIN_SCRIPT_FILE],
      { cwd: userDataDir() }
    )
    return
  }

  // Linux/BSD: try the common emulators, in order, until one launches.
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', executable]],
    ['gnome-terminal', ['--', executable]],
    ['konsole', ['-e', executable]],
    ['xterm', ['-e', executable]]
  ]
  for (const [command, args] of candidates) {
    try {
      await spawnDetached(command, args)
      return
    } catch {
      // Try the next emulator.
    }
  }
  throw new AppError(
    'io',
    'Could not find a terminal to open.',
    `Run ${executable} in a terminal and sign in there.`
  )
}
