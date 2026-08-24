/**
 * Working-directory resolution (PRD §14.2).
 *
 * The resolved path becomes the spawned Claude Code process's `cwd`, which is the
 * single most important input to how useful a Bot is — Claude Code reads, edits
 * and runs commands relative to it.
 *
 * Only `node:os` (for the home directory) and `node:fs` (for the existence probe)
 * are used, so this module stays trivially testable.
 */
import { homedir } from 'node:os'
import { statSync } from 'node:fs'

export type WorkspaceSource = 'conversation' | 'bot' | 'setting' | 'home'

export interface WorkspaceResolution {
  path: string
  source: WorkspaceSource
  /** True only when the path exists AND is a directory. */
  exists: boolean
}

export interface WorkspaceInput {
  conversationWorkspace: string | null
  botWorkspace: string | null
  defaultWorkspace: string | null
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Expand a leading `~`. Users type "~/dev/app" in the workspace field all the
 * time, and passing that through verbatim would make `spawn` fail with ENOENT on
 * a directory that plainly exists. `node:path` is deliberately not imported here,
 * so the join is done by hand.
 */
function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    const home = homedir()
    const rest = input.slice(2)
    const separator = home.endsWith('/') || home.endsWith('\\') ? '' : input[1]
    return `${home}${separator}${rest}`
  }
  return input
}

function isDirectory(path: string): boolean {
  try {
    // throwIfNoEntry:false turns "missing" into undefined instead of an exception;
    // a permission error still throws and is treated as "not usable".
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
  } catch {
    return false
  }
}

export function resolveWorkspace(input: WorkspaceInput): WorkspaceResolution {
  const candidates: Array<{ value: string | null; source: WorkspaceSource }> = [
    { value: clean(input.conversationWorkspace), source: 'conversation' },
    { value: clean(input.botWorkspace), source: 'bot' },
    { value: clean(input.defaultWorkspace), source: 'setting' }
  ]

  for (const candidate of candidates) {
    if (candidate.value === null) continue
    const path = expandHome(candidate.value)
    // A configured-but-missing directory is returned as-is with exists:false so the
    // caller can show the "workspace missing" card naming the path the user set,
    // rather than silently running the Bot somewhere else entirely.
    return { path, source: candidate.source, exists: isDirectory(path) }
  }

  const home = homedir()
  return { path: home, source: 'home', exists: isDirectory(home) }
}
