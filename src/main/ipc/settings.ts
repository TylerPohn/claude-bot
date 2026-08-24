/**
 * Settings read/write plus the OS-level side effects a settings change implies.
 *
 * `applySettingsSideEffects` is exported because bootstrap has to reconcile the
 * same three things (theme, login item, runtime path) on launch, not only when
 * the user edits them.
 */
import { app, nativeTheme } from 'electron'

import { IPC_CHANNELS } from '@shared/types/api'
import type { AppSettings } from '@shared/types'
import { settingsPatchSchema } from '@shared/schemas'
import { emit } from '@main/events'
import { settingsRepo } from '@main/db/repositories/settings'
import { AppError } from '@main/lib/errors'
import { log } from '@main/lib/logger'
import { explainUnusableExecutable } from '@main/runtime/ClaudeDetector'
import { refresh } from '@main/services/RuntimeService'
import { setBadgeEnabled } from '@main/services/BadgeService'

import { handle, noInput } from './index'

export function applySettingsSideEffects(settings: AppSettings): void {
  nativeTheme.themeSource = settings.appearance

  // The Dock badge is part of "notifications" as far as the user is concerned:
  // turning them off should not leave a red dot on the icon.
  setBadgeEnabled(settings.showNotifications)

  // `setLoginItemSettings` is a no-op stub on Linux; guard so we do not log noise.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      const current = app.getLoginItemSettings()
      if (current.openAtLogin !== settings.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
      }
    } catch (err) {
      log.warn('settings', 'could not update the login item', err)
    }
  }
}

export function registerSettingsIpc(): void {
  handle(IPC_CHANNELS.settingsGet, noInput, () => settingsRepo.get())

  handle(IPC_CHANNELS.settingsUpdate, settingsPatchSchema, (patch) => {
    // `claudeExecutablePath` is the one setting that decides which binary this app
    // spawns for every turn, and it is the one field two channels write. The
    // schema can only cap its length — whether a path exists and is executable is
    // not something a shared zod schema can know — so the filesystem check lives
    // here, matching `runtime:pickExecutable`. Without it a bad value was stored,
    // silently ignored by the detector (which falls back to auto-detection) and
    // reported back as a healthy runtime, with nothing telling the user why their
    // path had no effect. Null/empty is a deliberate reset to auto-detection.
    if (typeof patch.claudeExecutablePath === 'string' && patch.claudeExecutablePath.trim()) {
      const problem = explainUnusableExecutable(patch.claudeExecutablePath)
      if (problem) throw new AppError('invalid_input', problem, patch.claudeExecutablePath)
    }

    const previous = settingsRepo.get()
    const settings = settingsRepo.update(patch)

    applySettingsSideEffects(settings)

    // Pointing at a different binary invalidates everything we know about the
    // runtime; re-probe in the background and let `runtime:status` update the UI.
    if (settings.claudeExecutablePath !== previous.claudeExecutablePath) {
      void refresh(true)
    }

    emit('settings:updated', { settings })
    return settings
  })
}
