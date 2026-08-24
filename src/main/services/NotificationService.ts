/**
 * Native desktop notifications (PRD §33).
 *
 * Bots run in the background, so the interesting moments — a turn finishing, an
 * error, a rate limit — usually happen while the user is somewhere else. The
 * one rule that makes this tolerable rather than annoying: never notify about
 * the conversation the user is already looking at, unless they asked for it.
 */
import { BrowserWindow, Notification } from 'electron'

import { emit } from '@main/events'
import { log } from '@main/lib/logger'
import { newId } from '@main/lib/id'
import { conversationsRepo } from '@main/db/repositories/conversations'
import { settingsRepo } from '@main/db/repositories/settings'

export interface NotifyInput {
  conversationId: string
  title: string
  body: string
  level?: 'info' | 'error'
}

/** The conversation currently open in the renderer, or null when none is. */
let focusedConversationId: string | null = null

/**
 * Whether the app window itself has OS focus. Tracked separately from the open
 * conversation: a user with the app open behind their editor still wants to be
 * told that a Bot finished.
 */
let windowFocused = false

/**
 * Electron's `Notification` is a native handle owned by JS. If the only
 * reference is a local in `notify()` it can be collected before the OS has
 * finished with it, and the notification silently disappears (or its `click`
 * never fires). Hold a strong reference until the OS is done.
 */
const live = new Set<Notification>()

/**
 * Whether the user has already been told that the OS is refusing notifications.
 *
 * `Notification.isSupported()` returns true even when the app has been denied
 * permission — the refusal only shows up as a `failed` event per notification
 * ("The operation couldn't be completed. (UNErrorDomain error 1.)" on macOS), and
 * Electron exposes no main-process API for the authorization status. Without a
 * signal the user sees "Show notifications" switched ON in Settings and simply
 * never hears anything.
 *
 * `notify()` runs once per completed turn, so this is a one-shot per app run:
 * a toast per turn would be worse than the silence it replaces. It is cleared
 * again when a notification does get shown, so granting permission later restores
 * the warning for a future refusal.
 */
let blockedNoticeShown = false

export function setFocusedConversation(id: string | null): void {
  focusedConversationId = id
}

export function setWindowFocused(focused: boolean): void {
  const leaving = windowFocused && !focused
  windowFocused = focused
  // Everything that landed in the open conversation while the window had focus
  // arrived in front of the user, so bank it before the app goes to the back.
  if (leaving) bankFocusedRead()
}

/**
 * Advance the read watermark for the conversation that is on screen.
 *
 * Nothing else does while a conversation stays open: the renderer's `markRead`
 * short-circuits whenever it already believes the unread count is 0, so a reply
 * the user watched arrive left `last_read_at` frozen at the moment they opened
 * the chat. The sidebar hid the dot anyway (the store merges `unreadCount: 0`
 * into the open conversation), but the database did not agree — so the dock badge
 * counted messages that were on screen, and the count came back on the next
 * launch. Called when focus leaves: the conversation changes, or the window does.
 */
export function bankFocusedRead(): void {
  const id = focusedConversationId
  if (id === null) return
  try {
    const summary = conversationsRepo.getSummary(id)
    if (!summary || summary.unreadCount === 0) return
    conversationsRepo.markRead(id)
    const updated = conversationsRepo.getSummary(id)
    // Keeps the sidebar row and the badge in step; `emit` also schedules the
    // badge recompute, so no direct BadgeService call (and no import cycle).
    if (updated) emit('conversation:updated', { conversation: updated })
  } catch (err) {
    // Ambient bookkeeping. A failure costs an unread dot, never a message.
    log.warn('notifications', 'could not advance the read watermark', err)
  }
}

/** The conversation the renderer currently has open. Used by the app menu for ⌘. (Stop). */
export function getFocusedConversationId(): string | null {
  return focusedConversationId
}

/** Whether the app window has OS focus. Read by BadgeService, which must not
 *  count a conversation the user is sitting in front of. */
export function isWindowFocused(): boolean {
  return windowFocused
}

export function notify(input: NotifyInput): void {
  if (!Notification.isSupported()) return

  let showNotifications = true
  let notifyOnFocusedConversation = false
  try {
    const settings = settingsRepo.get()
    showNotifications = settings.showNotifications
    notifyOnFocusedConversation = settings.notifyOnFocusedConversation
  } catch (err) {
    // A settings read failure must not swallow an error notification, which is
    // exactly when the database is most likely to be unhappy. Fall through with
    // the defaults above.
    log.warn('notifications', 'could not read settings; using defaults', err)
  }

  if (!showNotifications) return

  const lookingAtIt =
    windowFocused && focusedConversationId !== null && focusedConversationId === input.conversationId
  if (lookingAtIt && !notifyOnFocusedConversation) return

  let notification: Notification
  try {
    notification = new Notification({
      title: input.title,
      body: input.body,
      // Errors get the default sound; routine completions stay quiet so a group
      // of Bots finishing does not turn into a chime storm.
      silent: input.level !== 'error'
    })
  } catch (err) {
    log.warn('notifications', 'could not construct notification', err)
    return
  }

  live.add(notification)
  const release = (): void => {
    live.delete(notification)
  }

  notification.on('click', () => {
    release()
    focusWindow()
    emit('app:navigate', { conversationId: input.conversationId })
  })
  notification.on('close', release)
  // `show` is the only reliable success signal available: it does not fire when
  // the OS refuses, so it is also how we learn that permission came back.
  notification.on('show', () => {
    blockedNoticeShown = false
  })
  notification.on('failed', (_event, error) => {
    release()
    // Electron types this argument as a plain string ("...UNErrorDomain error 1.").
    // The log is where that belongs — see `reportBlocked`.
    log.warn('notifications', 'system rejected notification', error)
    reportBlocked(input, 'refused')
  })

  try {
    notification.show()
  } catch (err) {
    release()
    log.warn('notifications', 'could not show notification', err)
    reportBlocked(input, 'failed')
  }
}

/**
 * Tell the user once that the setting they can see is not the state they are in.
 * The notice names the conversation the missed alert belonged to, so it reads as
 * "you nearly missed this" rather than as an abstract capability warning.
 *
 * The OS error string is deliberately NOT interpolated. On macOS it is a Cocoa
 * domain code — "The operation couldn't be completed. (UNErrorDomain error 1.)"
 * — which took up two of the toast's six lines and told the user nothing they
 * could act on. Both callers already `log.warn` it, so it is still in the
 * diagnostics the About tab copies; only the user-facing sentence changed.
 *
 * `cause` separates the two ways we get here. A `failed` event IS the OS refusing
 * (Electron exposes no authorization status in main), but a `show()` that throws
 * could be anything, and asserting "your system is blocking notifications" about
 * an unknown construction failure would send the user into System Settings to fix
 * something that is not broken there.
 */
function reportBlocked(input: NotifyInput, cause: 'refused' | 'failed'): void {
  if (blockedNoticeShown) return
  blockedNoticeShown = true
  emit('app:notice', {
    id: newId('notice'),
    level: 'warn',
    title:
      cause === 'refused'
        ? 'Your system is blocking notifications from this app'
        : 'That notification could not be shown',
    body:
      cause === 'refused'
        ? 'Bots will keep working and the sidebar still updates, but desktop alerts will not appear until this app is allowed to notify you in your system settings.'
        : 'Bots will keep working and the sidebar still updates, but this alert never reached your desktop. Settings → About → Copy diagnostics has the details.',
    conversationId: input.conversationId
  })
}

/**
 * Bring the app forward from a notification click. `show()` alone is not enough
 * on macOS when the window is minimised, and `focus()` alone is not enough when
 * it is hidden.
 */
function focusWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  const win = windows.find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
