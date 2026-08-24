import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CircleStop,
  FileDown,
  FolderOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  SunMoon,
  Users
} from 'lucide-react'

import type { Appearance, Bot, ConversationSummary } from '@shared/types'
import { formatRelativeShort, plainTextPreview } from '@/lib/format'
import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import { Kbd } from '@/components/ui/Kbd'
import { useFocusTrap } from '@/components/ui/Modal'

import { fuzzyPositions, fuzzyScore, highlightParts, isRelevantMatch } from './fuzzy'
import type { MatchKind } from './fuzzy'

/* ------------------------------------------------------------------ *
 * Shared palette chrome
 * ------------------------------------------------------------------ */

/**
 * The dialog shell both palettes wear (DESIGN §3.7): scrim, `top: 13vh` — NOT
 * vertically centred — 560px wide, `--surface-3`, radius 12, and the five-layer
 * `--shadow-dialog`. The layering is the point: five stacked low-alpha shadows at
 * different radii read as expensive where one big blur reads as a CSS default.
 *
 * `SearchPalette` imports this rather than re-declaring it, so the two ⌘K/⌘F
 * surfaces can never drift apart by a pixel.
 *
 * Vertical placement is done with `padding-top` on a flex row rather than
 * `top + translateX(-50%)`, because the `dialog-in` keyframe animates
 * `transform` — a centring translate would be clobbered mid-animation.
 */
export function PaletteShell({
  label,
  onClose,
  children
}: {
  label: string
  onClose(): void
  children: ReactNode
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, true, close)

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 'var(--z-palette)' }} role="presentation">
      <div
        aria-hidden
        onMouseDown={close}
        className="absolute inset-0"
        style={{
          background: 'var(--overlay)',
          animation: 'scrim-in var(--dur-base) var(--ease-out-quad)'
        }}
      />
      <div
        /* `items-start`, not the default `stretch`: a stretched panel is as tall
           as the viewport minus the 13vh inset, which the maxHeight below then
           clamps to a flat 500px in EVERY state. A two-hit search rendered 136px
           of rows and 275px of empty ground under them. Aligning to the start
           lets the panel size to its content and turns the maxHeight back into
           the cap it was written to be. */
        className="pointer-events-none absolute inset-0 flex items-start justify-center"
        style={{ paddingTop: '13vh', paddingLeft: 16, paddingRight: 16 }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          className="pointer-events-auto flex min-h-0 flex-col overflow-hidden outline-none"
          style={{
            width: 560,
            maxWidth: 'min(720px, 100%)',
            maxHeight: 'min(73vh, 500px)',
            background: 'var(--surface-3)',
            border: '1px solid var(--border-2)',
            borderRadius: 'var(--r-popover)',
            boxShadow: 'var(--shadow-dialog)',
            animation: 'dialog-in var(--dur-base) var(--ease-out-quad)'
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** 46px input row with a leading glyph. Shared by both palettes. */
export function PaletteInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  listId,
  activeId
}: {
  value: string
  onChange(next: string): void
  onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void
  placeholder: string
  listId: string
  activeId: string | undefined
}): ReactElement {
  return (
    <div
      className="flex shrink-0 items-center gap-[10px]"
      style={{ height: 46, padding: '0 18px', borderBottom: '1px solid var(--border-1)' }}
    >
      <Search size={16} strokeWidth={1.75} aria-hidden style={{ color: 'var(--fg-tertiary)' }} />
      <input
        data-autofocus
        autoFocus
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="selectable min-w-0 flex-1 bg-transparent text-[var(--fg-primary)] placeholder:text-[var(--fg-tertiary)]"
        style={{
          fontSize: 'var(--fs-ui)',
          letterSpacing: 'var(--ls-ui)',
          caretColor: 'var(--accent)',
          outline: 'none'
        }}
      />
    </div>
  )
}

export function PaletteFooter({ children }: { children: ReactNode }): ReactElement {
  return (
    <footer
      className="flex shrink-0 items-center gap-[14px]"
      style={{ height: 40, padding: '0 12px', borderTop: '1px solid var(--border-1)' }}
    >
      {children}
    </footer>
  )
}

export function PaletteHint({
  keys,
  label
}: {
  keys: string | string[]
  label: string
}): ReactElement {
  return (
    <span className="flex items-center gap-[6px]">
      {(Array.isArray(keys) ? keys : [keys]).map((k) => (
        <Kbd key={k} keys={k} />
      ))}
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}>{label}</span>
    </span>
  )
}

export function PaletteGroupHeading({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      className="flex items-center"
      style={{
        height: 30,
        paddingInline: 12,
        fontSize: 'var(--fs-micro)',
        lineHeight: 'var(--lh-micro)',
        letterSpacing: 'var(--ls-micro)',
        fontWeight: 510,
        color: 'var(--fg-tertiary)'
      }}
    >
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

interface PaletteItem {
  id: string
  group: string
  title: string
  subtitle?: string | null
  /** Right-aligned text hint (a timestamp, a type, a reason). */
  hint?: string | null
  /** Right-aligned shortcut chip, e.g. `'mod+n'`. */
  keys?: string | null
  icon: ReactNode
  /** Extra text that matches but is never displayed — synonyms, mostly. */
  keywords?: string
  disabled?: boolean
  run(): void
}

interface Scored {
  item: PaletteItem
  score: number
}

const GROUP_CONVERSATIONS = 'Conversations'
const GROUP_BOTS = 'Bots'
const GROUP_ACTIONS = 'Actions'
const GROUP_RECENT = 'Recent'

/** DESIGN §4.7 caps each result group; more than this is scroll, not signal. */
const PER_GROUP = 8
const RECENT_COUNT = 7

function GlyphCell({ children }: { children: ReactNode }): ReactElement {
  // 20px rather than the spec's 16px icon cell: conversation rows carry a real
  // BotAvatar, and every row in the list has to share one indent.
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: 20, height: 20, color: 'var(--fg-tertiary)' }}
    >
      {children}
    </span>
  )
}

function conversationGlyph(
  conversation: ConversationSummary,
  bots: Record<string, Bot>
): ReactNode {
  const members = conversation.memberBotIds
    .map((id) => bots[id])
    .filter((bot): bot is Bot => Boolean(bot))

  if (conversation.type === 'group' && members.length > 1) {
    return <GroupAvatar members={members} size={20} />
  }
  return (
    <BotAvatar
      bot={members[0]}
      name={conversation.name}
      size={20}
      avatarType={members[0] ? undefined : 'emoji'}
      avatarValue={members[0] ? undefined : (conversation.icon ?? '💬')}
    />
  )
}

/* ------------------------------------------------------------------ *
 * CommandPalette
 * ------------------------------------------------------------------ */

export function CommandPalette({ onClose }: { onClose: () => void }): ReactElement {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const bots = useAppStore((s) => s.bots)
  const botOrder = useAppStore((s) => s.botOrder)
  const conversations = useAppStore((s) => s.conversations)
  const conversationOrder = useAppStore((s) => s.conversationOrder)
  // Only the appearance matters here: it re-labels the theme command.
  const appearance = useAppStore((s) => s.settings?.appearance)
  const activeConversationId = useUiStore((s) => s.activeConversationId)

  const rowRefs = useRef(new Map<number, HTMLDivElement>())

  const openConversation = useCallback((conversationId: string) => {
    const app = useAppStore.getState()
    useUiStore.getState().setActive(conversationId)
    void app.loadMessages(conversationId)
    void app.markRead(conversationId)
  }, [])

  /* ---- the full candidate set ---------------------------------------- */

  const items = useMemo<PaletteItem[]>(() => {
    const ui = useUiStore.getState()
    const app = useAppStore.getState()
    const result: PaletteItem[] = []

    /* Conversations — every one, hidden included. The sidebar hides them; the
       palette is how you get back to them. */
    for (const id of conversationOrder) {
      const conversation = conversations[id]
      if (!conversation) continue
      const preview = plainTextPreview(conversation.lastMessagePreview, 90)
      const typeLabel = conversation.type === 'group' ? 'Group' : 'Direct'
      result.push({
        id: `conversation:${id}`,
        group: GROUP_CONVERSATIONS,
        title: app.conversationTitle(id),
        subtitle: preview || `${typeLabel}${conversation.hidden ? ' · Hidden' : ''}`,
        hint: formatRelativeShort(conversation.lastMessageAt) || typeLabel,
        icon: conversationGlyph(conversation, bots),
        keywords: conversation.type === 'group' ? 'group chat' : 'direct chat message',
        run: () => openConversation(id)
      })
    }

    /* Bots that have no direct conversation yet. A Bot whose chat already exists
       is reachable through its conversation row above, and listing it twice under
       the same name is the fastest way to make a palette feel careless. */
    const directBotIds = new Set<string>()
    for (const id of conversationOrder) {
      const conversation = conversations[id]
      if (conversation?.type === 'direct') {
        for (const botId of conversation.memberBotIds) directBotIds.add(botId)
      }
    }
    for (const botId of botOrder) {
      const bot = bots[botId]
      if (!bot || directBotIds.has(botId)) continue
      result.push({
        id: `bot:${botId}`,
        group: GROUP_BOTS,
        title: bot.name,
        subtitle: bot.title ?? plainTextPreview(bot.description, 90),
        hint: 'Open chat',
        icon: <BotAvatar bot={bot} size={20} />,
        keywords: 'bot agent chat',
        run: () => {
          void withToast(
            async () => {
              const conversation = await app.createDirect(botId)
              openConversation(conversation.id)
              return conversation
            },
            { errorTitle: `Could not open a chat with ${bot.name}` }
          )
        }
      })
    }

    /* Commands. */
    const runningBots = Object.values(conversations).reduce(
      (total, conversation) => total + conversation.runningBotIds.length,
      0
    )
    const activeId = activeConversationId
    const activeTitle = activeId ? app.conversationTitle(activeId) : null
    const resolvedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    const nextTheme: Appearance = resolvedTheme === 'dark' ? 'light' : 'dark'

    result.push(
      {
        id: 'command:new-bot',
        group: GROUP_ACTIONS,
        title: 'New Bot',
        subtitle: 'Name it, give it a job and a folder',
        keys: 'mod+n',
        icon: <Plus size={16} strokeWidth={1.75} />,
        keywords: 'create agent teammate add',
        run: () => ui.openModal({ kind: 'bot' })
      },
      {
        id: 'command:new-group',
        group: GROUP_ACTIONS,
        title: 'New Group',
        subtitle: 'Put several Bots and you in one thread',
        keys: 'mod+shift+n',
        icon: <Users size={16} strokeWidth={1.75} />,
        keywords: 'create group chat team room',
        run: () => ui.openModal({ kind: 'group' })
      },
      {
        id: 'command:search',
        group: GROUP_ACTIONS,
        title: 'Search messages',
        subtitle: 'Full-text search across every conversation',
        keys: 'mod+f',
        icon: <Search size={16} strokeWidth={1.75} />,
        keywords: 'find text transcript history',
        run: () => ui.setPalette('search')
      },
      {
        id: 'command:settings',
        group: GROUP_ACTIONS,
        title: 'Settings',
        subtitle: 'Claude Code, appearance, data',
        keys: 'mod+,',
        icon: <SettingsIcon size={16} strokeWidth={1.75} />,
        keywords: 'preferences options config claude code',
        run: () => ui.openModal({ kind: 'settings', tab: 'general' })
      },
      {
        id: 'command:theme',
        group: GROUP_ACTIONS,
        title: 'Toggle theme',
        subtitle: `Switch to ${nextTheme === 'dark' ? 'Dark' : 'Light'}`,
        icon: <SunMoon size={16} strokeWidth={1.75} />,
        keywords: 'dark light appearance mode colour color',
        run: () => {
          void app.updateSettings({ appearance: nextTheme })
        }
      },
      {
        id: 'command:stop-all',
        group: GROUP_ACTIONS,
        title: 'Stop all running Bots',
        subtitle:
          runningBots > 0
            ? `${runningBots} ${runningBots === 1 ? 'Bot is' : 'Bots are'} working`
            : 'Nothing is running right now',
        hint: runningBots > 0 ? null : 'Nothing running',
        icon: <CircleStop size={16} strokeWidth={1.75} />,
        keywords: 'cancel halt interrupt kill',
        disabled: runningBots === 0,
        run: () => {
          ui.confirm({
            title: `Stop ${runningBots} running ${runningBots === 1 ? 'Bot' : 'Bots'}?`,
            // PRD §22 / DESIGN §4.4 — stop is always accompanied by this line.
            body: 'This doesn’t undo actions already completed.',
            confirmLabel: 'Stop all',
            danger: true,
            onConfirm: () => {
              for (const conversation of Object.values(useAppStore.getState().conversations)) {
                if (conversation.runningBotIds.length > 0) {
                  void useAppStore.getState().stopConversation(conversation.id)
                }
              }
            }
          })
        }
      },
      {
        id: 'command:reveal-data',
        group: GROUP_ACTIONS,
        title: 'Reveal app data',
        subtitle: 'Your Bots, transcripts and settings on this computer',
        icon: <FolderOpen size={16} strokeWidth={1.75} />,
        keywords: 'folder finder explorer database local files',
        run: () => {
          void withToast(() => bridge().system.revealAppData(), {
            errorTitle: 'Could not open the app data folder'
          })
        }
      },
      {
        id: 'command:export',
        group: GROUP_ACTIONS,
        title: 'Export conversation',
        subtitle: activeTitle ? `Save “${activeTitle}” as Markdown` : 'Open a conversation first',
        hint: activeId ? null : 'No conversation open',
        icon: <FileDown size={16} strokeWidth={1.75} />,
        keywords: 'markdown save download transcript',
        disabled: !activeId,
        run: () => {
          if (!activeId) return
          void withToast(
            async () => {
              const exported = await bridge().conversations.exportMarkdown(activeId)
              const path = exported.path
              if (path) {
                ui.toast({
                  level: 'success',
                  title: 'Transcript exported',
                  body: path,
                  actionLabel: 'Reveal',
                  onAction: () => {
                    void bridge().system.revealPath(path)
                  }
                })
              }
              return exported
            },
            { errorTitle: 'Could not export that conversation' }
          )
        }
      }
    )

    return result
  }, [bots, botOrder, conversations, conversationOrder, appearance, activeConversationId, openConversation])

  /* ---- ranking -------------------------------------------------------- */

  const trimmed = query.trim()

  const groups = useMemo<Array<{ name: string; items: Scored[] }>>(() => {
    if (trimmed.length === 0) {
      // Empty query: the most recent conversations, then everything you can do.
      const recent: Scored[] = []
      for (const id of conversationOrder) {
        if (recent.length >= RECENT_COUNT) break
        const conversation = conversations[id]
        if (!conversation || conversation.hidden) continue
        const item = items.find((candidate) => candidate.id === `conversation:${id}`)
        if (item) recent.push({ item, score: 0 })
      }
      const actions = items
        .filter((item) => item.group === GROUP_ACTIONS)
        .map((item) => ({ item, score: 0 }))

      const out: Array<{ name: string; items: Scored[] }> = []
      if (recent.length > 0) out.push({ name: GROUP_RECENT, items: recent })
      out.push({ name: GROUP_ACTIONS, items: actions })
      return out
    }

    const scored: Scored[] = []
    for (const item of items) {
      /* Title is the strong signal; the subtitle and hidden keywords match too,
         but discounted, so "dark" can find Toggle theme without ever outranking
         a Bot literally called Dark.

         Each field has to clear the relevance floor ON ITS OWN before its score
         counts. Keeping every finite score meant a conversation's subtitle — 90
         characters of its last message — matched almost any short query as a
         scattered subsequence: "note" filled the palette with all six
         conversations and four commands, none containing the word. The floor
         asks whether the field READS as an answer (substring or initialism),
         which a rank threshold cannot do. */
      let score = -Infinity
      const consider = (text: string | null | undefined, discount: number, kind: MatchKind): void => {
        if (!text) return
        const value = fuzzyScore(trimmed, text)
        if (value === -Infinity || !isRelevantMatch(trimmed, text, kind)) return
        score = Math.max(score, value - discount)
      }
      consider(item.title, 0, 'name')
      // A subtitle is a conversation's last message and a keyword list is a bag
      // of synonyms — a user types one of those words, never their initials.
      consider(item.subtitle, 26, 'prose')
      consider(item.keywords, 34, 'prose')
      if (score !== -Infinity) scored.push({ item, score })
    }
    scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))

    /* Sections are ordered by their best hit rather than a fixed order: typing
       "set" should land on Settings, not scroll past three weakly-matching
       conversations first. First-seen order over the globally sorted list gives
       that for free. */
    const byGroup = new Map<string, Scored[]>()
    for (const entry of scored) {
      const bucket = byGroup.get(entry.item.group)
      if (bucket) {
        if (bucket.length < PER_GROUP) bucket.push(entry)
      } else {
        byGroup.set(entry.item.group, [entry])
      }
    }
    return Array.from(byGroup, ([name, entries]) => ({ name, items: entries }))
  }, [items, trimmed, conversations, conversationOrder])

  /** Flat list of the rows arrows can reach — disabled rows are shown, not visited. */
  const selectable = useMemo(() => {
    const flat: PaletteItem[] = []
    for (const group of groups) {
      for (const entry of group.items) {
        if (!entry.item.disabled) flat.push(entry.item)
      }
    }
    return flat
  }, [groups])

  const indexById = useMemo(() => {
    const map = new Map<string, number>()
    selectable.forEach((item, index) => map.set(item.id, index))
    return map
  }, [selectable])

  // A new query means a new best match; the selection always returns to the top.
  useEffect(() => {
    setActiveIndex(0)
  }, [trimmed])

  const clampedIndex = selectable.length === 0 ? -1 : Math.min(activeIndex, selectable.length - 1)
  const activeItem = clampedIndex >= 0 ? selectable[clampedIndex] : undefined

  // Layout effect: scrolling after paint would show the row in the wrong place
  // for one frame while arrowing quickly.
  useLayoutEffect(() => {
    if (clampedIndex < 0) return
    rowRefs.current.get(clampedIndex)?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex, groups])

  const runItem = useCallback(
    (item: PaletteItem) => {
      if (item.disabled) return
      // Close FIRST: an action that opens another surface (Search messages, the
      // settings modal) must not have the palette closing on top of it.
      onClose()
      item.run()
    },
    [onClose]
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (selectable.length === 0) {
        if (e.key === 'Enter') e.preventDefault()
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((clampedIndex + 1) % selectable.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((clampedIndex - 1 + selectable.length) % selectable.length)
          break
        case 'Home':
          e.preventDefault()
          setActiveIndex(0)
          break
        case 'End':
          e.preventDefault()
          setActiveIndex(selectable.length - 1)
          break
        case 'Enter': {
          e.preventDefault()
          const item = selectable[clampedIndex]
          if (item) runItem(item)
          break
        }
        default:
          break
      }
    },
    [clampedIndex, runItem, selectable]
  )

  const listId = 'ccb-command-list'
  const total = groups.reduce((count, group) => count + group.items.length, 0)

  return (
    <PaletteShell label="Command palette" onClose={onClose}>
      <PaletteInput
        value={query}
        onChange={setQuery}
        onKeyDown={onKeyDown}
        placeholder="Search conversations, Bots and commands…"
        listId={listId}
        activeId={activeItem ? `${listId}-${activeItem.id}` : undefined}
      />

      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        className="scroller min-h-0 flex-1 overflow-y-auto"
        style={{ padding: 6, scrollPaddingBlock: 6 }}
      >
        {total === 0 ? (
          <div
            className="flex flex-col items-center justify-center text-center"
            style={{ padding: '34px 24px', gap: 6 }}
          >
            <p
              style={{
                fontSize: 'var(--fs-chrome)',
                fontWeight: 550,
                color: 'var(--fg-primary)'
              }}
            >
              No matches for “{trimmed}”
            </p>
            <p style={{ fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}>
              Try a shorter word, or press{' '}
              <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                <Kbd keys="mod+f" />
              </span>{' '}
              to search inside messages.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <PaletteGroupHeading>{group.name}</PaletteGroupHeading>
              {group.items.map(({ item }) => {
                const index = indexById.get(item.id) ?? -1
                const selected = index >= 0 && index === clampedIndex
                return (
                  <PaletteRow
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    item={item}
                    query={trimmed}
                    selected={selected}
                    onActivate={() => runItem(item)}
                    onHover={() => {
                      if (index >= 0) setActiveIndex(index)
                    }}
                    registerRef={(node) => {
                      if (index < 0) return
                      if (node) rowRefs.current.set(index, node)
                      else rowRefs.current.delete(index)
                    }}
                  />
                )
              })}
            </div>
          ))
        )}
      </div>

      <PaletteFooter>
        <PaletteHint keys={['up', 'down']} label="Navigate" />
        <PaletteHint keys="enter" label="Open" />
        <PaletteHint keys="escape" label="Close" />
        <span className="flex-1" />
        {total > 0 ? (
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}>
            {total} {total === 1 ? 'result' : 'results'}
          </span>
        ) : null}
      </PaletteFooter>
    </PaletteShell>
  )
}

/* ------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------ */

/**
 * `role="option"` on a div, not a `<button>`: this is a combobox +
 * `aria-activedescendant` listbox, so focus deliberately never leaves the input.
 * Making each row focusable would put it in the Tab order and fight the pattern.
 * Every action here is reachable from the keyboard through the input.
 */
function PaletteRow({
  id,
  item,
  query,
  selected,
  onActivate,
  onHover,
  registerRef
}: {
  id: string
  item: PaletteItem
  query: string
  selected: boolean
  onActivate(): void
  onHover(): void
  registerRef(node: HTMLDivElement | null): void
}): ReactElement {
  const parts = useMemo(
    () => (query ? highlightParts(item.title, fuzzyPositions(query, item.title)) : null),
    [item.title, query]
  )

  return (
    <div
      ref={registerRef}
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={item.disabled || undefined}
      data-selected={selected || undefined}
      onClick={onActivate}
      onMouseMove={item.disabled ? undefined : onHover}
      className="row-pill flex items-center"
      style={{
        minHeight: 46,
        padding: '8px 12px',
        gap: 12,
        opacity: item.disabled ? 0.4 : 1
      }}
    >
      <GlyphCell>{item.icon}</GlyphCell>

      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 1 }}>
        <span
          className="truncate"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 1.35,
            letterSpacing: 'var(--ls-meta)',
            fontWeight: 550,
            // Selected rows promote their text to primary (DESIGN §3.7).
            color: selected ? 'var(--fg-primary)' : 'var(--fg-secondary)'
          }}
        >
          {parts
            ? parts.map((part, i) =>
                part.match ? (
                  <span key={i} style={{ color: 'var(--accent)' }}>
                    {part.text}
                  </span>
                ) : (
                  <span key={i}>{part.text}</span>
                )
              )
            : item.title}
        </span>
        {item.subtitle ? (
          <span
            className="truncate"
            style={{
              fontSize: 'var(--fs-micro)',
              lineHeight: 'var(--lh-micro)',
              letterSpacing: 'var(--ls-micro)',
              color: 'var(--fg-tertiary)'
            }}
          >
            {item.subtitle}
          </span>
        ) : null}
      </span>

      {item.keys ? (
        <Kbd keys={item.keys} />
      ) : item.hint ? (
        <span
          className="shrink-0 truncate"
          style={{
            maxWidth: 120,
            fontSize: 'var(--fs-micro)',
            color: 'var(--fg-quaternary)'
          }}
        >
          {item.hint}
        </span>
      ) : null}
    </div>
  )
}
