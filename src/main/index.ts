/**
 * App bootstrap.
 *
 * The order below is load-bearing:
 *
 *   paths -> database -> settings -> login-shell PATH -> (runtime probe, async)
 *   -> MCP control server -> job scheduler -> window -> IPC -> menu -> recover()
 *
 * Why:
 *   - settings must exist before anything reads `maxConcurrentBots` or the theme;
 *   - `resolveShellEnv()` is awaited because a GUI-launched Electron app inherits
 *     a minimal PATH, and both the Claude detector and the editor launcher depend
 *     on the real one (ARCHITECTURE §3.2);
 *   - the Claude probe is deliberately NOT awaited — it shells out to a login
 *     shell and would show up as a second of dead time before the first paint.
 *     It broadcasts `runtime:status` when it lands;
 *   - the control server must be listening before the scheduler can hand a
 *     `--mcp-config` to a spawned turn;
 *   - IPC is registered after the window exists so the first renderer call
 *     cannot race an unregistered channel;
 *   - `recover()` runs last: it marks orphaned `running` jobs as interrupted
 *     (PRD 37 — never claim a dead process is still executing) and drains the queue.
 */
import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import { emit, setEventTarget } from '@main/events'
import { closeDatabase, initDatabase } from '@main/db'
import { settingsRepo } from '@main/db/repositories/settings'
import { registerIpc } from '@main/ipc'
import { applySettingsSideEffects } from '@main/ipc/settings'
import { log } from '@main/lib/logger'
import { databasePath, isMac } from '@main/lib/paths'
import { mcpConfigForJob, startControlServer, stopControlServer } from '@main/mcp/controlServer'
import { getScheduler, initScheduler } from '@main/orchestration/JobScheduler'
import { getRuntime } from '@main/runtime/ClaudeCodeRuntime'
import { resolveShellEnv } from '@main/runtime/ClaudeDetector'
import { buildAppMenu } from '@main/services/AppMenu'
import { disposeBadge, refreshBadgeNow } from '@main/services/BadgeService'
import {
  handoffToBot,
  handoffToGroup,
  listBotsInConversation
} from '@main/services/ConversationService'
import { notify, setFocusedConversation, setWindowFocused } from '@main/services/NotificationService'
import { initialize as initializeRuntimeStatus } from '@main/services/RuntimeService'
import { createWindow, focusMainWindow, getMainWindow, installSecurityHandlers } from '@main/window'

const APP_NAME = 'Claude Code Bots'

let schedulerReady = false
let shuttingDown = false

function wireWindow(win: BrowserWindow): void {
  setEventTarget(win)

  // NotificationService suppresses notifications for the conversation the user is
  // already looking at, which requires knowing whether the window has focus.
  win.on('focus', () => setWindowFocused(true))
  win.on('blur', () => setWindowFocused(false))
  setWindowFocused(win.isFocused())

  win.on('closed', () => {
    setEventTarget(null)
    setFocusedConversation(null)
    setWindowFocused(false)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('window', `renderer gone: ${details.reason}`, details)
  })
}

async function onReady(): Promise<void> {
  installSecurityHandlers()

  initDatabase(databasePath())
  log.info('app', `database ready at ${databasePath()}`)

  const settings = settingsRepo.get()
  applySettingsSideEffects(settings)

  try {
    await resolveShellEnv()
  } catch (err) {
    // Worst case we fall back to the inherited PATH; detection has its own fallbacks.
    log.warn('app', 'could not resolve the login shell environment', err)
  }

  // Fire-and-forget: emits `runtime:status` when the probe finishes.
  initializeRuntimeStatus()

  try {
    const { port } = await startControlServer({
      handoff: (input) => handoffToBot(input),
      groupHandoff: (input) => handoffToGroup(input),
      listBots: (input) => listBotsInConversation(input)
    })
    log.info('app', `mcp control server on 127.0.0.1:${port}`)
  } catch (err) {
    // Handoffs degrade to "unavailable"; the app is still fully usable without them.
    log.error('app', 'could not start the MCP control server', err)
  }

  initScheduler({
    runtime: getRuntime(),
    emit,
    notify,
    // The control server needs to know which Bot/conversation a turn belongs to so
    // the bridge can be launched with the right identity. The declared dep takes no
    // argument, so accept an optional context and pass it through when given.
    mcpConfigJson: (context?: { botId: string; conversationId: string }) =>
      context ? mcpConfigForJob(context) : null
  })
  schedulerReady = true

  const win = createWindow()
  wireWindow(win)

  registerIpc()
  buildAppMenu(win)

  // Startup recovery, last, once every dependency it touches is live.
  getScheduler().recover()

  // Paint the Dock badge from whatever was unread when the app last quit,
  // rather than waiting for the first event to arrive.
  refreshBadgeNow()

  log.info('app', `${APP_NAME} ready`)
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info('app', 'shutting down')
  disposeBadge()

  if (schedulerReady) {
    try {
      // Kills any live Claude process trees rather than orphaning them.
      await getScheduler().dispose()
    } catch (err) {
      log.error('app', 'scheduler dispose failed', err)
    }
  }
  try {
    await stopControlServer()
  } catch (err) {
    log.warn('app', 'control server stop failed', err)
  }
  try {
    closeDatabase()
  } catch (err) {
    log.error('app', 'database close failed', err)
  }
}

function fatal(err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  log.error('app', 'fatal error during startup', message)
  try {
    dialog.showErrorBox(`${APP_NAME} could not start`, message)
  } catch {
    // No GUI available — the log line above is the record.
  }
  app.exit(1)
}

function main(): void {
  app.setName(APP_NAME)

  // One instance owns the SQLite file and the spawned process tree. A second
  // launch just surfaces the window that already exists.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('second-instance', () => focusMainWindow())

  app.on('window-all-closed', () => {
    // macOS apps stay resident with the menu bar; elsewhere closing the window
    // ends the app (and `before-quit` performs the shutdown).
    if (!isMac()) app.quit()
  })

  app.on('activate', () => {
    if (getMainWindow()) {
      focusMainWindow()
      return
    }
    // Dock click after the window was closed: rebuild it against live state.
    const win = createWindow()
    wireWindow(win)
    buildAppMenu(win)
  })

  app.on('before-quit', (event) => {
    if (shuttingDown) return
    // Shutdown is async (process trees, WAL checkpoint); hold the quit until it
    // is done, then exit explicitly.
    event.preventDefault()
    void shutdown().finally(() => app.exit(0))
  })

  process.on('unhandledRejection', (reason) => {
    log.error('app', 'unhandled rejection', reason)
  })
  process.on('uncaughtException', (err) => {
    log.error('app', 'uncaught exception', err)
  })

  app.whenReady().then(onReady).catch(fatal)
}

main()
