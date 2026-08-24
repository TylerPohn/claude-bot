/**
 * OS integration: dialogs, reveal/open, terminal + editor launch, the native
 * context menu, diagnostics, backup and the destructive "clear all data".
 *
 * The renderer has no shell access of its own (PRD 38.3): every entry point here
 * is validated, and every process launch passes an argv ARRAY with `shell:false`
 * so no user-supplied path can ever be interpreted as shell syntax (PRD 38.5).
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { Menu, app, clipboard, dialog, session, shell } from 'electron'
import type { MenuItemConstructorOptions, OpenDialogOptions } from 'electron'
import { z } from 'zod'

import { IPC_CHANNELS } from '@shared/types/api'
import type { ContextMenuItem, PickFilesResult } from '@shared/types/api'
import { closeDatabase } from '@main/db'
import { AppError } from '@main/lib/errors'
import { isDirectoryPath, isExecutablePath } from '@main/lib/executablePath'
import { log } from '@main/lib/logger'
import { databasePath, isMac, logsDir, userDataDir } from '@main/lib/paths'
import { getScheduler } from '@main/orchestration/JobScheduler'
import { buildReport } from '@main/services/DiagnosticsService'
import { exportBackup, importBackup } from '@main/services/ExportService'
import { resolveShellEnv } from '@main/runtime/ClaudeDetector'
import { getMainWindow } from '@main/window'

import { handle, noInput } from './index'

const pathSchema = z.object({ path: z.string().min(1).max(4096) })
const pickDirectorySchema = z.object({ defaultPath: z.string().max(4096).optional() })
const openExternalSchema = z.object({ url: z.string().min(1).max(4096) })
const copyTextSchema = z.object({ text: z.string().max(1_000_000) })

/** Recursive menu shape; `z.lazy` breaks the self-reference. */
const contextMenuItemSchema: z.ZodType<ContextMenuItem> = z.lazy(() =>
  z.object({
    id: z.string().max(80).optional(),
    label: z.string().max(300).optional(),
    type: z.enum(['normal', 'separator', 'checkbox']).optional(),
    checked: z.boolean().optional(),
    enabled: z.boolean().optional(),
    danger: z.boolean().optional(),
    submenu: z.array(contextMenuItemSchema).max(50).optional()
  })
)
const contextMenuSchema = z.object({ items: z.array(contextMenuItemSchema).max(100) })

/** Schemes we hand to the OS. Anything else (file:, javascript:, …) is refused. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.tiff': 'image/tiff'
}

async function showOpenDialog(options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const window = getMainWindow()
  // Sheet-attached dialogs on macOS require the window overload.
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}

/** Launch a GUI helper and forget about it; rejects only if the binary is missing. */
function spawnDetached(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...options
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function describeFile(path: string): PickFilesResult['files'][number] {
  const stat = statSync(path, { throwIfNoEntry: false, bigint: false })
  const mimeType = IMAGE_EXTENSIONS[extname(path).toLowerCase()] ?? null
  const isFolder = stat?.isDirectory() === true
  return {
    path,
    name: basename(path),
    sizeBytes: stat?.isFile() ? stat.size : null,
    kind: isFolder ? 'folder' : mimeType?.startsWith('image/') ? 'image' : 'file',
    mimeType: isFolder ? null : mimeType
  }
}

function toMenuTemplate(
  items: ContextMenuItem[],
  onClick: (id: string) => void
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' }

    const option: MenuItemConstructorOptions = {
      label: item.label ?? '',
      enabled: item.enabled !== false
    }
    if (item.type === 'checkbox') {
      option.type = 'checkbox'
      option.checked = item.checked === true
    }
    if (item.submenu && item.submenu.length > 0) {
      option.submenu = toMenuTemplate(item.submenu, onClick)
    } else if (item.id) {
      option.click = () => onClick(item.id as string)
    }
    // `danger` has no native equivalent on macOS; the renderer styles its own
    // menus for that case and we simply render a normal item here.
    return option
  })
}

export function registerSystemIpc(): void {
  handle(IPC_CHANNELS.systemPickDirectory, pickDirectorySchema, async ({ defaultPath }) => {
    const result = await showOpenDialog({
      title: 'Choose a working directory',
      defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : homedir(),
      buttonLabel: 'Use folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] ?? null }
  })

  handle(IPC_CHANNELS.systemPickFiles, noInput, async (): Promise<PickFilesResult> => {
    // Folders are attachable as context (PRD 17.3). Only macOS can offer files and
    // folders in one dialog; elsewhere we fall back to files.
    const properties: OpenDialogOptions['properties'] = isMac()
      ? ['openFile', 'openDirectory', 'multiSelections', 'dontAddToRecent']
      : ['openFile', 'multiSelections', 'dontAddToRecent']

    const result = await showOpenDialog({
      title: 'Attach files',
      defaultPath: homedir(),
      buttonLabel: 'Attach',
      properties
    })
    if (result.canceled) return { files: [] }
    return { files: result.filePaths.map(describeFile) }
  })

  handle(IPC_CHANNELS.systemRevealPath, pathSchema, ({ path }) => {
    shell.showItemInFolder(path)
  })

  handle(IPC_CHANNELS.systemOpenPath, pathSchema, async ({ path }) => {
    // Reveal instead of run. The user still gets to see the file — and to open it
    // themselves, having read its real name — but a click in the app never hands
    // an executable to the OS.
    if (isExecutablePath(path)) {
      log.warn('system', 'refused to open an executable path; revealing it instead', { path })
      shell.showItemInFolder(path)
      return
    }
    const failure = await shell.openPath(path)
    if (failure) throw new AppError('io', 'Could not open that path.', failure)
  })

  handle(IPC_CHANNELS.systemOpenExternal, openExternalSchema, async ({ url }) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new AppError('invalid_input', 'That is not a valid link.')
    }
    if (!EXTERNAL_SCHEMES.has(parsed.protocol)) {
      throw new AppError('invalid_input', 'Only web and mail links can be opened.')
    }
    await shell.openExternal(parsed.toString())
  })

  handle(IPC_CHANNELS.systemOpenTerminalAt, pathSchema, async ({ path }) => {
    if (!existsSync(path)) throw new AppError('not_found', 'That folder no longer exists.')

    // A terminal is opened AT A DIRECTORY, never at a file. `open -a Terminal
    // <file>` does not mean "show me that folder": Terminal.app declares
    // CFBundleTypeRole=Shell for `com.apple.terminal.shell-script` and
    // `public.unix-executable`, so LaunchServices RUNS the file — this handler
    // executed a `.command` end to end while its two siblings (openPath and the
    // openEditorAt fallback) refused the identical path.
    //
    // Both tests are needed. `isDirectory` alone lets a `.app` through, because
    // a bundle IS a directory; `isExecutablePath` alone lets a plain
    // `payload.sh` through only on the extensions we list. And the path is not
    // guaranteed first-party — `workspaceDirectory` / `defaultWorkingDirectory`
    // come straight out of an imported backup, and a file-valued workspace even
    // fires the "workspace missing" card whose primary action is this channel.
    if (!isDirectoryPath(path) || isExecutablePath(path)) {
      log.warn('system', 'refused to open a terminal at a path that is not a folder', { path })
      throw new AppError(
        'invalid_input',
        'That is a file, not a folder, so it cannot be opened in a terminal.',
        path
      )
    }

    if (isMac()) {
      await spawnDetached('open', ['-a', 'Terminal', path])
      return
    }
    if (process.platform === 'win32') {
      // The working directory is set through `cwd`, never interpolated into a
      // command string for cmd.exe to re-parse — `&`, `^`, `%` and `(` are all
      // legal in a Windows directory name, and this file's header promises that
      // no user-supplied path is ever handed to a shell parser (PRD 38.5).
      //
      // The empty third token is START's *title*. It is not optional padding:
      // START reads its first unquoted argument as the program to run, so the
      // old `start Terminal cmd /k …` tried to launch a program called
      // `Terminal` (there is no such alias — Windows Terminal is `wt.exe`) and
      // failed silently. libuv emits an empty argument as `""`, which START
      // reads as a blank title, and `cmd` then runs as intended.
      await spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd', '/k'], { cwd: path })
      return
    }
    const candidates: Array<[string, string[]]> = [
      ['x-terminal-emulator', ['--working-directory', path]],
      ['gnome-terminal', ['--working-directory', path]],
      ['konsole', ['--workdir', path]],
      ['xterm', ['-e', 'cd', path]]
    ]
    for (const [command, args] of candidates) {
      try {
        await spawnDetached(command, args)
        return
      } catch {
        // Try the next emulator.
      }
    }
    throw new AppError('io', 'Could not find a terminal to open.')
  })

  handle(IPC_CHANNELS.systemOpenEditorAt, pathSchema, async ({ path }) => {
    if (!existsSync(path)) throw new AppError('not_found', 'That path no longer exists.')
    try {
      // `code` is almost never on a GUI-launched app's PATH, so use the resolved
      // login-shell environment (same problem ClaudeDetector solves for `claude`).
      const env = await resolveShellEnv()
      await spawnDetached('code', [path], { env })
      return
    } catch (err) {
      log.info('system', 'no `code` on PATH, falling back to the default handler', err)
    }
    // Same gate as systemOpenPath: a conversation's working directory is not
    // necessarily first-party either (an imported backup supplies it), and this
    // fallback is a plain `shell.openPath`.
    if (isExecutablePath(path)) {
      log.warn('system', 'refused to open an executable path; revealing it instead', { path })
      shell.showItemInFolder(path)
      return
    }
    const failure = await shell.openPath(path)
    if (failure) throw new AppError('io', 'Could not open that path.', failure)
  })

  handle(IPC_CHANNELS.systemPathExists, pathSchema, ({ path }) => existsSync(path))

  handle(IPC_CHANNELS.systemCopyText, copyTextSchema, ({ text }) => {
    clipboard.writeText(text)
  })

  handle(IPC_CHANNELS.systemContextMenu, contextMenuSchema, ({ items }) => {
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null
      const menu = Menu.buildFromTemplate(
        toMenuTemplate(items, (id) => {
          chosen = id
        })
      )
      const window = getMainWindow()
      menu.popup({
        ...(window ? { window } : {}),
        callback: () => {
          // On macOS the click handler can run just after the close callback, so
          // settle on the next tick rather than reporting a spurious dismissal.
          setTimeout(() => resolve(chosen), 30)
        }
      })
    })
  })

  handle(IPC_CHANNELS.systemDiagnostics, noInput, () => buildReport())

  handle(IPC_CHANNELS.systemExportBackup, noInput, () => exportBackup())

  handle(IPC_CHANNELS.systemImportBackup, noInput, () => importBackup())

  handle(IPC_CHANNELS.systemRevealAppData, noInput, async () => {
    const failure = await shell.openPath(userDataDir())
    if (failure) throw new AppError('io', 'Could not open the app data folder.', failure)
  })

  handle(IPC_CHANNELS.systemClearAllData, noInput, async () => {
    const window = getMainWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Delete everything'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete all local data?',
      message: 'Delete every Bot, conversation and setting?',
      detail:
        'This removes the local database and app data on this computer. Your files and your Claude Code installation are not touched. The app will restart.'
    }
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (response !== 1) return

    log.warn('system', 'clearing all local data at the user’s request')

    // Kill live Claude processes before pulling the database out from under them.
    try {
      await getScheduler().dispose()
    } catch (err) {
      log.warn('system', 'scheduler dispose failed during wipe', err)
    }
    try {
      closeDatabase()
    } catch (err) {
      log.warn('system', 'database close failed during wipe', err)
    }

    // Only app-owned entries are removed. Electron keeps open handles inside
    // userData (Cache, GPUCache, Local Storage…), so deleting the directory
    // wholesale under a live process is unsafe; `clearStorageData` handles those.
    const db = databasePath()
    const targets = [db, `${db}-wal`, `${db}-shm`, logsDir(), join(userDataDir(), 'window-state.json')]
    for (const target of targets) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch (err) {
        log.warn('system', `could not remove ${target}`, err)
      }
    }
    try {
      await session.defaultSession.clearStorageData()
    } catch (err) {
      log.warn('system', 'could not clear web storage', err)
    }

    app.relaunch()
    app.exit(0)
  })

  handle(IPC_CHANNELS.systemAppInfo, noInput, () => ({
    version: app.getVersion(),
    platform: process.platform,
    isMac: isMac()
  }))
}
