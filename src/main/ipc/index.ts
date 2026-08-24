/**
 * IPC registration and the one wrapper every handler goes through.
 *
 * Invariants for the whole `src/main/ipc` directory:
 *   - one `ipcMain.handle` per channel in `IPC_CHANNELS`; no ad-hoc channel names;
 *   - every payload is a SINGLE argument, Zod-parsed before anything else runs
 *     (PRD 26 / 38.6). Multi-argument renderer calls are packed into an object by
 *     the preload (`bots.update(id, patch)` -> `{ id, patch }`);
 *   - handlers return plain JSON-cloneable data; they never return live objects;
 *   - thrown errors are serialized into the Error message so the preload can
 *     rebuild a typed error (see ERROR ENVELOPE below).
 *
 * ERROR ENVELOPE
 * --------------
 * Electron only transports an Error's `message` across the ipc + contextBridge
 * boundary — custom properties are dropped (measured, Electron 43). So the error
 * code travels inside the message:
 *
 *     __CCB_ERR__{"code":"not_found","message":"…","detail":"…"}__CCB_END__
 *
 * Electron prefixes the renderer-side message with
 * `Error invoking remote method '<channel>': `, so the preload must SEARCH for
 * the markers rather than assume the string starts with them. The mirrored
 * parsing lives in `src/preload/index.ts` — change both sides together.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'

import type { IpcChannel } from '@shared/types/api'
import { AppError, serializeError } from '@main/lib/errors'
import { log } from '@main/lib/logger'

import { registerBotsIpc } from './bots'
import { registerConversationsIpc } from './conversations'
import { registerMessagesIpc } from './messages'
import { registerRuntimeIpc } from './runtime'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'

/**
 * Zod v4 ships its messages as swappable locales and marks the package
 * side-effect-free, so a bundled main process tree-shakes the English locale
 * away and EVERY validation failure degrades to the bare fallback
 * "<path>: Invalid input" — in toasts, in logs, everywhere. Installing it
 * explicitly is what makes "Keep names under 40 characters" reach the user.
 */
z.config(z.locales.en())

export const IPC_ERROR_PREFIX = '__CCB_ERR__'
export const IPC_ERROR_SUFFIX = '__CCB_END__'

/** Schema for channels that take no payload; `ipcRenderer.invoke(ch)` sends undefined. */
export const noInput = z.void()

function envelope(channel: IpcChannel, err: unknown): Error {
  const payload = serializeError(err)
  log.error('ipc', `${channel} failed: ${payload.message}`, payload)
  return new Error(`${IPC_ERROR_PREFIX}${JSON.stringify(payload)}${IPC_ERROR_SUFFIX}`)
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid input'
  // `path` entries can be symbols in zod v4, so stringify before joining.
  const path = issue.path.map((segment) => String(segment)).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Registers one validated handler. `fn` receives the PARSED value (defaults
 * applied), so downstream services never re-validate.
 */
export function handle<S extends z.ZodType, R>(
  channel: IpcChannel,
  schema: S,
  fn: (input: z.output<S>) => R | Promise<R>
): void {
  // Dev restarts re-run registerIpc against a live ipcMain; replacing beats throwing.
  ipcMain.removeHandler(channel)

  ipcMain.handle(channel, async (_event, raw: unknown) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw envelope(channel, new AppError('invalid_input', firstIssueMessage(parsed.error)))
    }
    try {
      return await fn(parsed.data)
    } catch (err) {
      throw envelope(channel, err)
    }
  })
}

export function registerIpc(): void {
  registerBotsIpc()
  registerConversationsIpc()
  registerMessagesIpc()
  registerRuntimeIpc()
  registerSettingsIpc()
  registerSystemIpc()
  log.info('ipc', 'handlers registered')
}
