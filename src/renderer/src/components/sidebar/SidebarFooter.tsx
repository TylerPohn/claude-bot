import type { ReactElement } from 'react'
import { EyeOff, Settings } from 'lucide-react'

import { useUiStore } from '@/stores/uiStore'
import { IconButton } from '@/components/ui/IconButton'

/**
 * 40px footer. The `Show hidden chats` row only appears when something is
 * actually hidden (DESIGN §2.2); the settings button is always present because
 * a desktop app needs one discoverable, mouse-reachable route into preferences —
 * ⌘, and the app menu are not enough on their own.
 */
export function SidebarFooter({ hiddenCount }: { hiddenCount: number }): ReactElement {
  const showHidden = useUiStore((s) => s.showHidden)
  const setShowHidden = useUiStore((s) => s.setShowHidden)
  const openModal = useUiStore((s) => s.openModal)

  return (
    <div
      className="flex shrink-0 items-center gap-[4px]"
      style={{
        height: 40,
        padding: '0 8px 0 12px',
        borderTop: '1px solid var(--border-1)'
      }}
    >
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowHidden(!showHidden)}
          aria-pressed={showHidden}
          className="flex min-w-0 flex-1 items-center gap-[6px] rounded-[var(--r-3)] text-left text-[var(--fg-tertiary)] transition-[color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:text-[var(--fg-primary)]"
          style={{ height: 28, fontSize: 'var(--fs-meta)' }}
        >
          <EyeOff size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">
            {showHidden ? 'Hide hidden chats' : 'Show hidden chats'}
          </span>
        </button>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      <IconButton
        label="Settings"
        size={28}
        onClick={() => openModal({ kind: 'settings', tab: 'general' })}
      >
        <Settings size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}
