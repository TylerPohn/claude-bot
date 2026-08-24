import { useCallback, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  MessageSquarePlus,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users
} from 'lucide-react'

import { cn } from '@/lib/cn'
import { plainTextPreview } from '@/lib/format'
import { useAppStore } from '@/stores/appStore'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUiStore
} from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Popover, PopoverDivider, PopoverItem } from '@/components/ui/Popover'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConversationRow } from './ConversationRow'
import { PinnedStrip } from './PinnedStrip'
import { SidebarFooter } from './SidebarFooter'
import { SidebarHeader } from './SidebarHeader'
import { SidebarSection } from './SidebarSection'

/** DESIGN §4.1: 50 Bots and groups combined (mirrors SidebarHeader). */
const MAX_CONVERSATIONS = 50

export interface SidebarProps {
  /**
   * Opens the full-text message palette seeded with the sidebar's filter term.
   *
   * The field at the top of the sidebar filters names, Bot titles and the
   * one-line preview — it does NOT look inside transcripts, which is what PRD
   * §20.1's search does. A user who types a word they remember from a message
   * used to get "No matches" and a dead end, with no hint that ⌘F would have
   * found it instantly. Every state that shows a term now offers this route.
   */
  onSearchMessages(query: string): void
}

export function Sidebar({ onSearchMessages }: SidebarProps): ReactElement {
  const width = useUiStore((s) => s.sidebarWidth)
  const collapsedPreference = useUiStore((s) => s.sidebarCollapsed)
  const viewportWidth = useUiStore((s) => s.viewportWidth)
  // DESIGN §2.1: the sidebar becomes a rail below 1000px. This is derived, never
  // written back — widening the window must restore the user's own preference.
  const collapsedByWidth = viewportWidth < 1000
  const collapsed = collapsedPreference || collapsedByWidth
  const showHidden = useUiStore((s) => s.showHidden)
  const openModal = useUiStore((s) => s.openModal)

  const ready = useAppStore((s) => s.ready)
  const order = useAppStore((s) => s.conversationOrder)
  const conversations = useAppStore((s) => s.conversations)
  const bots = useAppStore((s) => s.bots)

  const [query, setQuery] = useState('')

  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const pinned: string[] = []
    const direct: string[] = []
    const groups: string[] = []
    const hidden: string[] = []

    for (const id of order) {
      const conversation = conversations[id]
      if (!conversation) continue

      if (needle) {
        const bot = bots[conversation.memberBotIds[0] ?? '']
        const haystack = [
          conversation.name,
          bot?.name ?? '',
          bot?.title ?? '',
          plainTextPreview(conversation.lastMessagePreview, 160)
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) continue
      }

      if (conversation.hidden) {
        hidden.push(id)
        continue
      }
      // While filtering, pinned rows join the normal sections: a strip of
      // avatars is not a useful way to show search results.
      if (conversation.pinned && !needle) {
        pinned.push(id)
        continue
      }
      if (conversation.type === 'group') groups.push(id)
      else direct.push(id)
    }

    return { pinned, direct, groups, hidden }
  }, [bots, conversations, order, query])

  const hiddenCount = useMemo(
    () => Object.values(conversations).filter((c) => c.hidden).length,
    [conversations]
  )

  const totalVisible =
    buckets.pinned.length + buckets.direct.length + buckets.groups.length + buckets.hidden.length

  /* ---- resize ------------------------------------------------------- */

  const asideRef = useRef<HTMLElement>(null)
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const originX = e.clientX
      const originWidth = asideRef.current?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH

      const onMove = (move: PointerEvent): void => {
        setSidebarWidth(originWidth + (move.clientX - originX))
      }
      const onUp = (): void => {
        handle.releasePointerCapture(e.pointerId)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
      }
      // The cursor is forced on <body> for the duration: without it the cursor
      // flickers back to the default every time the pointer crosses a child.
      document.body.style.cursor = 'col-resize'
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
    },
    [setSidebarWidth]
  )

  /* ---- collapsed rail ----------------------------------------------- */

  if (collapsed) {
    return (
      <aside
        className="relative flex h-full shrink-0 flex-col"
        style={{
          width: 'var(--sidebar-rail-w)',
          background: 'var(--surface-1)',
          borderRight: '1px solid var(--border-1)'
        }}
        aria-label="Conversations"
      >
        {/* On macOS the traffic lights need this whole strip to themselves — a
            56px rail cannot fit them and a control in the same row. */}
        <div className="drag shrink-0" style={{ height: 'var(--header-h)' }} />
        <ScrollArea className="flex-1 py-[4px]">
          {order
            .filter((id) => conversations[id] && (showHidden || !conversations[id]!.hidden))
            .map((id) => (
              <ConversationRow key={id} conversationId={id} compact />
            ))}
        </ScrollArea>
        <RailFooter canExpand={!collapsedByWidth} />
      </aside>
    )
  }

  /* ---- full sidebar -------------------------------------------------- */

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full shrink-0 flex-col"
      style={{
        width,
        background: 'var(--surface-1)',
        borderRight: '1px solid var(--border-1)'
      }}
      aria-label="Conversations"
    >
      <SidebarHeader
        query={query}
        onQueryChange={setQuery}
        onSearchMessages={() => onSearchMessages(query.trim())}
      />

      {!ready ? (
        <SidebarSkeleton />
      ) : totalVisible === 0 ? (
        // The wrapper keeps the footer pinned to the bottom of the column.
        <div className="flex-1">
          {query.trim() ? (
            <EmptyState
              compact
              className="mt-[24px]"
              title="No matches"
              body={`No conversation name, Bot or preview matches “${query.trim()}”. Your transcripts have not been searched yet.`}
              action={
                <Button
                  size="sm"
                  leading={<Search size={14} strokeWidth={1.75} />}
                  onClick={() => onSearchMessages(query.trim())}
                >
                  Search all messages
                </Button>
              }
            />
          ) : (
            <EmptyState
              className="mt-[32px]"
              icon={<Sparkles size={28} strokeWidth={1.5} />}
              title="No Bots yet"
              body="A Bot is a named Claude Code teammate with its own standing instructions, working folder and memory of your conversation."
              action={
                <Button
                  variant="filled"
                  leading={<MessageSquarePlus size={16} strokeWidth={1.75} />}
                  onClick={() => openModal({ kind: 'bot' })}
                >
                  Create your first Bot
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <ScrollArea className="flex-1 pb-[8px]">
          <PinnedStrip conversationIds={buckets.pinned} />

          <SidebarSection
            id="direct"
            label="Direct"
            count={buckets.direct.length}
            first
            isEmpty={buckets.direct.length === 0}
            empty={
              <p
                className="text-[var(--fg-quaternary)]"
                style={{ padding: '4px 20px 8px', fontSize: 'var(--fs-meta)' }}
              >
                No direct chats.
              </p>
            }
          >
            {buckets.direct.map((id) => (
              <ConversationRow key={id} conversationId={id} />
            ))}
          </SidebarSection>

          {buckets.groups.length > 0 ? (
            <SidebarSection id="groups" label="Groups" count={buckets.groups.length}>
              {buckets.groups.map((id) => (
                <ConversationRow key={id} conversationId={id} />
              ))}
            </SidebarSection>
          ) : null}

          {showHidden && buckets.hidden.length > 0 ? (
            <SidebarSection id="hidden" label="Hidden" count={buckets.hidden.length}>
              {buckets.hidden.map((id) => (
                <ConversationRow key={id} conversationId={id} />
              ))}
            </SidebarSection>
          ) : null}

          {/* Not gated on an empty result: the filter also matches Bot titles
              and the 160-char preview, so a list with rows in it can still be
              hiding the transcript the user is actually after. */}
          {query.trim() ? (
            <SearchAllRow query={query.trim()} onRun={() => onSearchMessages(query.trim())} />
          ) : null}
        </ScrollArea>
      )}

      <SidebarFooter hiddenCount={hiddenCount} />

      {/* Resize handle. A real separator with keyboard support — dragging is not
          the only way a person should be able to change a pane's width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            setSidebarWidth(width - (e.shiftKey ? 24 : 8))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            setSidebarWidth(width + (e.shiftKey ? 24 : 8))
          }
        }}
        className={cn(
          'no-drag absolute top-0 right-[-3px] bottom-0 z-[var(--z-sticky)] w-[6px] cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] after:bg-transparent',
          'after:transition-[background-color] after:duration-[var(--dur-fast)] after:ease-[var(--ease-out-quad)]',
          'hover:after:bg-[var(--border-3)] focus-visible:after:bg-[var(--accent)]'
        )}
      />
    </aside>
  )
}

/**
 * The bridge from filtering to searching, at the bottom of the filtered list.
 *
 * Deliberately not a conversation row: it is 40px rather than 60, carries no
 * avatar and states the term it will search for, so it reads as an action about
 * the query rather than as one more result.
 */
function SearchAllRow({ query, onRun }: { query: string; onRun(): void }): ReactElement {
  return (
    <div className="row-pill relative" style={{ marginInline: 8, marginTop: 4 }}>
      <button
        type="button"
        onClick={onRun}
        className="flex w-full items-center gap-[10px] rounded-[var(--r-row)] text-left text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
        style={{ height: 40, padding: '0 8px' }}
      >
        <span
          aria-hidden
          className="grid shrink-0 place-items-center"
          style={{ width: 24, height: 24 }}
        >
          <Search size={15} strokeWidth={1.75} />
        </span>
        <span
          className="min-w-0 flex-1 truncate"
          style={{ fontSize: 'var(--fs-meta)', letterSpacing: 'var(--ls-meta)' }}
        >
          Search all messages for <span style={{ color: 'var(--fg-primary)' }}>“{query}”</span>
        </span>
      </button>
    </div>
  )
}

/**
 * The rail's own footer.
 *
 * The rail is not a decoration: the window's minimum width is 900px and the rail
 * takes over below 1000, so at the smallest size the app allows this IS the
 * sidebar. It used to hold one "New Bot" button, which meant Settings and search
 * — whose only other routes are the native menu and accelerators the user has to
 * already know — had no in-window affordance at all, and there was nothing at
 * all to undo a ⌘B. Four 28px buttons stacked in a 56px column is what fits;
 * every one carries a right-side tooltip because the rail has no room for labels.
 */
function RailFooter({ canExpand }: { canExpand: boolean }): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  const openModal = useUiStore((s) => s.openModal)
  const setPalette = useUiStore((s) => s.setPalette)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  // Same 50-conversation cap the full header enforces (DESIGN §4.1); the rail
  // must not be a back door around it.
  const atLimit = useAppStore((s) => s.conversationOrder.length) >= MAX_CONVERSATIONS

  return (
    <div
      className="flex shrink-0 flex-col items-center gap-[2px]"
      style={{ padding: '6px 0 8px', borderTop: '1px solid var(--border-1)' }}
    >
      {/* Only when the width is not forcing the rail. Below 1000px the collapse
          is derived from the viewport and the preference is ignored, so an
          expand button there would be a control the user can click forever with
          nothing happening. */}
      {canExpand ? (
        <Tooltip label="Expand sidebar (⌘B)" side="right">
          <IconButton label="Expand sidebar" size={28} onClick={() => setSidebarCollapsed(false)}>
            <PanelLeftOpen size={16} strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      ) : null}

      {/* The rail cannot host the header's inline filter field, so the ⌘F
          palette stands in for it — it searches every transcript rather than
          filtering the list, which is the more useful of the two at this size. */}
      <Tooltip label="Search messages" side="right">
        <IconButton label="Search messages" size={28} onClick={() => setPalette('search')}>
          <Search size={16} strokeWidth={1.75} />
        </IconButton>
      </Tooltip>

      <Tooltip label="New" side="right">
        <IconButton
          ref={plusRef}
          label="New"
          size={28}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus size={16} strokeWidth={1.75} />
        </IconButton>
      </Tooltip>

      <Tooltip label="Settings" side="right">
        <IconButton
          label="Settings"
          size={28}
          onClick={() => openModal({ kind: 'settings', tab: 'general' })}
        >
          <Settings size={16} strokeWidth={1.75} />
        </IconButton>
      </Tooltip>

      {/* Same menu as the full sidebar's + button: the rail used to open the Bot
          sheet directly, which quietly deleted New Group Chat at narrow widths. */}
      <Popover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={plusRef}
        align="start"
        side="top"
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
            setPalette('search')
          }}
        >
          Search messages
        </PopoverItem>
      </Popover>
    </div>
  )
}

/**
 * Skeletons match the real row geometry exactly (40px avatar, two text lines at
 * the real widths) and stagger down the list. A placeholder that does not match
 * what replaces it destroys the trust it was meant to build.
 */
function SidebarSkeleton(): ReactElement {
  return (
    <div className="flex-1" style={{ paddingTop: 12 }} aria-hidden>
      <div style={{ paddingInline: 20, marginBottom: 10 }}>
        <Skeleton width={56} height={10} index={0} />
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="flex items-center gap-[10px]"
          style={{ height: 60, padding: '10px 16px' }}
        >
          <Skeleton width={40} height={40} radius="var(--r-full)" index={i} />
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 6 }}>
            <Skeleton width={`${52 + ((i * 13) % 30)}%`} height={11} index={i} />
            <Skeleton width={`${68 + ((i * 7) % 24)}%`} height={9} index={i} />
          </div>
        </div>
      ))}
    </div>
  )
}
