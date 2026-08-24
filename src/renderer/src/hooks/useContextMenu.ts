import { useCallback } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import type { ContextMenuItem } from '@shared/types/api'
import { bridge } from '@/lib/ipc'

/**
 * Native context menus, per the polish checklist: the menu is BUILT and POPPED in
 * the main process. The renderer only cancels the default menu and ships the
 * template over IPC, so the items get real platform styling, real keyboard
 * navigation and free localization for `role`-based entries.
 *
 * The template is rebuilt on every invocation by the caller, which is what keeps
 * `checked` / `enabled` state from going stale.
 */
export function useContextMenu(): (
  items: ContextMenuItem[],
  e?: ReactMouseEvent
) => Promise<string | null> {
  return useCallback(async (items: ContextMenuItem[], e?: ReactMouseEvent) => {
    if (e) {
      e.preventDefault()
      // Without this, a row's menu and the list's menu both fire and the second
      // popup replaces the first.
      e.stopPropagation()
    }
    if (items.length === 0) return null
    try {
      return await bridge().system.contextMenu(items)
    } catch {
      // A failed menu must never break the row that opened it.
      return null
    }
  }, [])
}
