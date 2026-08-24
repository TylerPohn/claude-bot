/**
 * Native application menu.
 *
 * Two things this file is careful about:
 *
 *  - **Roles over hand-rolled items.** An Edit menu built from `click` handlers
 *    looks identical and quietly breaks ⌘C/⌘V inside the renderer's text
 *    fields, because the native edit commands are what actually drive a
 *    webContents selection. Every standard item here uses `role`.
 *  - **The menu is a real client of the app.** Items that mirror in-app UI emit
 *    `app:command` (ARCHITECTURE §7) and let the renderer decide what to open;
 *    items that are genuinely main-process work (export, diagnostics, stopping
 *    a run) are performed here.
 */
import { BrowserWindow, Menu, app, clipboard, dialog, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { emit } from '@main/events'
import { isMac } from '@main/lib/paths'
import { log } from '@main/lib/logger'
import { getScheduler } from '@main/orchestration/JobScheduler'
import { buildReport } from './DiagnosticsService'
import { exportBackup, exportConversationMarkdown, importBackup } from './ExportService'
import { getFocusedConversationId } from './NotificationService'
import type { AppEventMap } from '@shared/types/events'

type AppCommand = AppEventMap['app:command']['command']

const DOCS_URL = 'https://docs.claude.com/en/docs/claude-code'

function sendCommand(command: AppCommand): void {
  emit('app:command', { command })
}

/**
 * ⌘. (Stop) is handled in the main process rather than sent as an `app:command`:
 * the shared `app:command` union has no `stop` member, and main already knows
 * which conversation is open because the renderer reports it to the
 * notification service. Stopping is scheduler work anyway.
 */
async function stopFocusedConversation(): Promise<void> {
  const conversationId = getFocusedConversationId()
  if (!conversationId) return
  try {
    await getScheduler().stopConversation(conversationId)
  } catch (err) {
    // The scheduler is not initialized until bootstrap finishes; a menu click
    // before then should do nothing rather than crash the main process.
    log.warn('menu', 'stop from menu failed', err)
  }
}

async function exportFocusedConversation(): Promise<void> {
  const conversationId = getFocusedConversationId()
  if (!conversationId) return
  try {
    await exportConversationMarkdown(conversationId)
  } catch (err) {
    log.error('menu', 'conversation export failed', err)
  }
}

async function copyDiagnostics(): Promise<void> {
  try {
    const report = await buildReport()
    clipboard.writeText(JSON.stringify(report, null, 2))
  } catch (err) {
    log.error('menu', 'could not build diagnostics report', err)
  }
}

function run(task: () => Promise<unknown>): () => void {
  // Menu `click` handlers are fire-and-forget; an unhandled rejection here
  // would surface as a main-process warning with no context.
  return () => {
    void task().catch((err: unknown) => log.error('menu', 'menu action failed', err))
  }
}

export function buildAppMenu(win: BrowserWindow): void {
  const mac = isMac()

  // Populates the native About panel on macOS and Linux instead of the bare
  // Electron default.
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: process.versions.electron ?? '',
    copyright: 'Your Claude Code team, in a chat app.'
  })

  const template: MenuItemConstructorOptions[] = []

  /* ---- App menu (macOS only) ---- */

  if (mac) {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => sendCommand('settings') },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  /* ---- File ---- */

  const fileSubmenu: MenuItemConstructorOptions[] = [
    { label: 'New Bot…', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-bot') },
    {
      label: 'New Group…',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => sendCommand('new-group')
    },
    { type: 'separator' },
    {
      label: 'Export Conversation as Markdown…',
      accelerator: 'CmdOrCtrl+Shift+E',
      click: run(exportFocusedConversation)
    },
    { label: 'Export Backup…', click: run(exportBackup) },
    { label: 'Import Backup…', click: run(importBackup) },
    { type: 'separator' }
  ]

  if (mac) {
    fileSubmenu.push({ role: 'close' })
  } else {
    fileSubmenu.push(
      { label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendCommand('settings') },
      { type: 'separator' },
      { role: 'quit' }
    )
  }

  template.push({ label: '&File', submenu: fileSubmenu })

  /* ---- Edit (roles only, so native shortcuts keep working) ---- */

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' }
  ]

  if (mac) {
    editSubmenu.push(
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Speech',
        submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
      }
    )
  } else {
    editSubmenu.push({ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' })
  }

  editSubmenu.push(
    { type: 'separator' },
    { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('search') }
  )

  template.push({ label: '&Edit', submenu: editSubmenu })

  /* ---- View ---- */

  template.push({
    label: '&View',
    submenu: [
      {
        label: 'Command Palette…',
        accelerator: 'CmdOrCtrl+K',
        click: () => sendCommand('command-palette')
      },
      {
        // ⌘B is common muscle memory (Finder, VS Code), and it persists across
        // restarts — it used to be an accelerator that appeared in no menu, on
        // no tooltip and in no shortcuts sheet, so a user who tripped it landed
        // in a nameless avatar rail with no listed way back.
        label: 'Toggle Sidebar',
        accelerator: 'CmdOrCtrl+B',
        click: () => sendCommand('toggle-sidebar')
      },
      {
        label: 'Toggle Details',
        accelerator: 'CmdOrCtrl+I',
        click: () => sendCommand('toggle-details')
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' }
    ]
  })

  /* ---- Chat ---- */

  template.push({
    label: '&Chat',
    submenu: [
      {
        label: 'Stop',
        accelerator: 'CmdOrCtrl+.',
        click: run(stopFocusedConversation)
      }
    ]
  })

  /* ---- Window ---- */

  const windowSubmenu: MenuItemConstructorOptions[] = [{ role: 'minimize' }, { role: 'zoom' }]
  if (mac) {
    windowSubmenu.push({ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' })
  } else {
    windowSubmenu.push({ role: 'close' })
  }
  template.push({ label: '&Window', role: 'window', submenu: windowSubmenu })

  /* ---- Help ---- */

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      // DESIGN §4.8 requires this sheet, and it is the app's only shortcut
      // reference: several real bindings (⌘B, the transcript's arrow-key
      // navigation into a message's action bar) appear on no other surface.
      label: 'Keyboard Shortcuts',
      accelerator: 'CmdOrCtrl+/',
      click: () => sendCommand('shortcuts')
    },
    { type: 'separator' },
    {
      label: 'Claude Code Documentation',
      click: run(() => shell.openExternal(DOCS_URL))
    },
    { type: 'separator' },
    { label: 'Copy Diagnostics', click: run(copyDiagnostics) }
  ]

  if (!mac) {
    helpSubmenu.push(
      { type: 'separator' },
      {
        label: `About ${app.getName()}`,
        click: run(async () => {
          if (win.isDestroyed()) return
          await dialog.showMessageBox(win, {
            type: 'info',
            title: `About ${app.getName()}`,
            message: app.getName(),
            detail: [
              `Version ${app.getVersion()}`,
              `Electron ${process.versions.electron ?? 'unknown'}`,
              `Node ${process.versions.node}`,
              '',
              'Your Claude Code team, in a chat app.'
            ].join('\n')
          })
        })
      }
    )
  }

  template.push({ label: '&Help', role: 'help', submenu: helpSubmenu })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
