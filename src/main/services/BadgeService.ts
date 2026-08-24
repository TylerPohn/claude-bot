/**
 * Dock / taskbar unread badge.
 *
 * PRD §33 and the Settings copy both promise that "the sidebar dot and the dock
 * badge always update either way" — i.e. the badge tracks unread activity even
 * when notifications are suppressed because the window is focused. This is the
 * piece that makes that true.
 *
 * The count is recomputed from the database rather than accumulated, so it can
 * never drift out of sync with what the sidebar shows. `refreshBadge` is called
 * from the single event choke point in `events.ts`, which means it fires on the
 * streaming hot path — hence the coalescing timer.
 */
import { app } from 'electron'

import { conversationsRepo } from '@main/db/repositories/conversations'
import { log } from '@main/lib/logger'
import { getFocusedConversationId, isWindowFocused } from '@main/services/NotificationService'

/** Streaming emits ~30 events/second per running Bot; one DB read per tick is plenty. */
const COALESCE_MS = 400

let timer: NodeJS.Timeout | null = null
let lastCount = -1
let enabled = true

/** Windows/Linux have no dock; `setBadgeCount` is a no-op there but still safe. */
function apply(count: number): void {
  if (count === lastCount) return
  lastCount = count
  try {
    app.setBadgeCount(count)
  } catch (err) {
    // A badge is cosmetic. Never let it take down anything upstream.
    log.debug('badge', 'could not set badge count', err)
  }
}

function compute(): number {
  try {
    // The conversation the user is actually looking at, if any. A reply landing in
    // front of them is not unread, and the sidebar already agrees: the renderer
    // merges `unreadCount: 0` into the open+focused conversation, so counting it
    // here put a number on the Dock for a row that shows no dot. The stored
    // watermark is advanced by `conversations:setFocused` when they leave it.
    const watched = isWindowFocused() ? getFocusedConversationId() : null
    let total = 0
    for (const conversation of conversationsRepo.listSummaries()) {
      if (conversation.hidden) continue
      if (conversation.id === watched) continue
      total += conversation.unreadCount
    }
    return total
  } catch (err) {
    log.debug('badge', 'could not compute unread count', err)
    return lastCount < 0 ? 0 : lastCount
  }
}

/** Coalesced refresh. Safe to call as often as you like. */
export function refreshBadge(): void {
  if (!enabled) return
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    apply(compute())
  }, COALESCE_MS)
  timer.unref?.()
}

/** Immediate refresh, for the moments where the delay would be visible. */
export function refreshBadgeNow(): void {
  if (!enabled) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  apply(compute())
}

/**
 * Mirrors the "Show notifications" preference: a user who has turned
 * notifications off should not keep getting a red dot on the Dock icon.
 */
export function setBadgeEnabled(next: boolean): void {
  enabled = next
  if (!enabled) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    apply(0)
    // Allow the next enable to repaint even if the count is unchanged.
    lastCount = -1
  } else {
    refreshBadgeNow()
  }
}

export function disposeBadge(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
