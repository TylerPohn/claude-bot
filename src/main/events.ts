/**
 * Main -> renderer push channel.
 *
 * Everything the renderer needs to react to (new messages, streaming deltas, job
 * state, runtime health) travels over ONE ipc channel (`APP_EVENT_CHANNEL`) as a
 * discriminated `{ type, payload }` union. A single channel keeps the preload
 * bridge to exactly one `ipcRenderer.on` listener no matter how many event names
 * exist, which is what makes the fan-out in `src/preload/index.ts` cheap.
 *
 * `emit` is deliberately fire-and-forget and never throws: it is called from the
 * job scheduler's hot streaming path (~30 emits/second per running Bot) and from
 * shutdown paths where the window may already be gone.
 */
import type { BrowserWindow } from 'electron'

import { APP_EVENT_CHANNEL } from '@shared/types/api'
import type { AppEventMap, AppEventName } from '@shared/types/events'
import { log } from '@main/lib/logger'
import { refreshBadge } from '@main/services/BadgeService'

/**
 * Events that can change the unread total. `emit` is the one place every state
 * change in the app funnels through, so hanging the badge refresh here means it
 * can never be forgotten at a call site.
 */
const BADGE_EVENTS = new Set<AppEventName>([
  'message:created',
  'message:updated',
  'message:deleted',
  'conversation:created',
  'conversation:updated',
  'conversation:deleted'
])

let target: BrowserWindow | null = null

/** Point the emitter at the (possibly recreated) main window. Pass null on close. */
export function setEventTarget(win: BrowserWindow | null): void {
  target = win
}

export function emit<K extends AppEventName>(name: K, payload: AppEventMap[K]): void {
  // Before the window checks below: a Bot finishing while the window is closed
  // or hidden is precisely when the Dock badge matters. Coalesced internally,
  // so calling it from the streaming hot path is cheap.
  if (BADGE_EVENTS.has(name)) refreshBadge()

  const win = target
  if (!win || win.isDestroyed()) return

  const contents = win.webContents
  // A window can be alive while its renderer is gone (crash / reload in flight).
  if (contents.isDestroyed() || contents.isCrashed()) return

  try {
    contents.send(APP_EVENT_CHANNEL, { type: name, payload })
  } catch (err) {
    // Losing a push event must never take down a Claude turn mid-stream.
    log.warn('events', `failed to deliver ${name}`, err)
  }
}
