/**
 * Claude Code health: status, re-check, "open a terminal so I can log in", and
 * manually pointing the app at a `claude` binary.
 */
import { homedir } from 'node:os'

import { dialog } from 'electron'
import type { OpenDialogOptions } from 'electron'

import { IPC_CHANNELS } from '@shared/types/api'
import { emit } from '@main/events'
import { settingsRepo } from '@main/db/repositories/settings'
import { AppError } from '@main/lib/errors'
import { getStatus, openLoginTerminal, refresh } from '@main/services/RuntimeService'
import { getMainWindow } from '@main/window'

import { handle, noInput } from './index'
import { explainUnusableExecutable } from '@main/runtime/ClaudeDetector'

/** The renderer asks for this during bootstrap, so it must answer instantly. */
export function registerRuntimeIpc(): void {
  handle(IPC_CHANNELS.runtimeStatus, noInput, () => getStatus())

  handle(IPC_CHANNELS.runtimeRecheck, noInput, () => refresh(true))

  handle(IPC_CHANNELS.runtimeOpenLoginTerminal, noInput, () => openLoginTerminal())

  handle(IPC_CHANNELS.runtimePickExecutable, noInput, async () => {
    const window = getMainWindow()
    const options: OpenDialogOptions = {
      title: 'Select the claude executable',
      defaultPath: homedir(),
      buttonLabel: 'Use this',
      // The binary has no extension and often lives in a dot-directory
      // (~/.claude/local/claude), so hidden files must be selectable.
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return { path: null }
    const path = result.filePaths[0]
    if (!path) return { path: null }

    // Shared with the settings channel so the two cannot drift into disagreeing
    // about what a usable executable is, or into wording the same refusal
    // differently.
    const problem = explainUnusableExecutable(path)
    if (problem) throw new AppError('invalid_input', problem)

    const settings = settingsRepo.update({ claudeExecutablePath: path })
    emit('settings:updated', { settings })
    // Re-probe in the background; the resulting `runtime:status` event updates the UI.
    void refresh(true)
    return { path }
  })
}
