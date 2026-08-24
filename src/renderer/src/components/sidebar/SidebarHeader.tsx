import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Plus, Search, Users, X } from 'lucide-react'

import { titleBarInsetLeft } from '@/lib/platform'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { IconButton } from '@/components/ui/IconButton'
import { Popover, PopoverDivider, PopoverItem } from '@/components/ui/Popover'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Tooltip } from '@/components/ui/Tooltip'

/** DESIGN §4.1: 50 Bots and groups combined. */
const MAX_CONVERSATIONS = 50

export interface SidebarHeaderProps {
  query: string
  onQueryChange(query: string): void
  /** Hands the typed term to the full-text palette — see `SidebarProps`. */
  onSearchMessages(): void
}

/**
 * The 56px top strip.
 *
 * The whole bar is a drag region so the window can be moved from it, and every
 * control inside carries `.no-drag` — a drag region swallows all pointer events,
 * so a button that forgets it emits no clicks and no hover at all. On macOS the
 * bar reserves 80px on the left for the `hiddenInset` traffic lights.
 *
 * The bar also must NOT contain the conversation rows: attaching a custom
 * context menu inside a drag region shows the system menu on some platforms.
 */
export function SidebarHeader({
  query,
  onQueryChange,
  onSearchMessages
}: SidebarHeaderProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const openModal = useUiStore((s) => s.openModal)
  const conversationCount = useAppStore((s) => s.conversationOrder.length)
  const atLimit = conversationCount >= MAX_CONVERSATIONS

  return (
    <div
      className="drag flex shrink-0 items-center gap-[6px]"
      style={{
        height: 'var(--header-h)',
        paddingLeft: titleBarInsetLeft(),
        paddingRight: 8
      }}
    >
      {/* A field, not a button: it filters the list in place, which is a
          different job from the ⌘K palette that searches every transcript. */}
      <div
        // `field`: the ring belongs on this pill, not around the text inside the
        // transparent <input> — which would leave the magnifier and the clear
        // button sitting outside it. See main.css.
        className="field no-drag flex min-w-0 flex-1 items-center gap-[6px]"
        style={{
          height: 30,
          paddingInline: 8,
          background: 'var(--surface-2)',
          borderRadius: 'var(--r-4)'
        }}
        onClick={() => inputRef.current?.focus()}
      >
        <Search size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--fg-tertiary)]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              onQueryChange('')
            }
            // Enter is the keyboard half of the "Search all messages" row at the
            // bottom of the list: this field only filters names and previews, so
            // pressing Enter in it used to do nothing at all.
            if (e.key === 'Enter' && query.trim()) {
              e.preventDefault()
              onSearchMessages()
            }
          }}
          placeholder="Search"
          aria-label="Filter conversations"
          className="selectable min-w-0 flex-1 bg-transparent text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            letterSpacing: 'var(--ls-meta)',
            caretColor: 'var(--accent)'
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => onQueryChange('')}
            className="grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
          >
            <X size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      <Tooltip label={atLimit ? 'You’ve reached 50 Bots and groups.' : 'New'} side="bottom">
        <IconButton
          ref={plusRef}
          label="New"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus size={18} strokeWidth={1.75} />
        </IconButton>
      </Tooltip>

      <Popover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={plusRef}
        align="end"
        width={200}
        label="Create"
      >
        <PopoverItem
          disabled={atLimit}
          leading={<BotAvatar name="New Bot" size={16} accent="violet" avatarValue="squircle" />}
          onSelect={() => {
            setMenuOpen(false)
            openModal({ kind: 'bot' })
          }}
        >
          New Bot
        </PopoverItem>
        <PopoverItem
          disabled={atLimit}
          leading={<Users size={16} strokeWidth={1.75} />}
          onSelect={() => {
            setMenuOpen(false)
            openModal({ kind: 'group' })
          }}
        >
          New Group Chat
        </PopoverItem>
        <PopoverDivider />
        <PopoverItem
          leading={<Search size={16} strokeWidth={1.75} />}
          onSelect={() => {
            setMenuOpen(false)
            useUiStore.getState().setPalette('search')
          }}
        >
          Search messages
        </PopoverItem>
      </Popover>
    </div>
  )
}
