import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { Info, MessageCircle, Search, User, Users } from 'lucide-react'

import type { Bot, SearchResult } from '@shared/types'
import { formatRelativeShort, plainTextSnippet } from '@/lib/format'
import { bridge, errorMessage } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { BotAvatar } from '@/components/ui/BotAvatar'
import { Skeleton } from '@/components/ui/Skeleton'

import { splitMatchSentinels } from './fuzzy'
import { PaletteFooter, PaletteHint, PaletteInput, PaletteShell } from './CommandPalette'

/** DESIGN §4.7 debounces the query. 150ms is long enough to skip most of a
 *  typed word and short enough that results feel keystroke-live. */
const DEBOUNCE_MS = 150
/** `searchSchema` caps the query at 200 characters. */
const MAX_QUERY = 200
const LIMIT = 50

export function SearchPalette({
  onClose,
  initialQuery
}: {
  onClose: () => void
  /** Seed from a caller that already has the user's term — the sidebar's
   *  "Search all messages for …" row hands its filter text straight over so the
   *  user does not retype it. Read once, at mount; the palette is remounted on
   *  every open, so there is no stale-seed state to reconcile. */
  initialQuery?: string
}): ReactElement {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const bots = useAppStore((s) => s.bots)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  /** Monotonic request id: a slower earlier query must never overwrite a newer one. */
  const requestId = useRef(0)

  const trimmed = query.trim().slice(0, MAX_QUERY)

  useEffect(() => {
    if (trimmed.length === 0) {
      requestId.current += 1
      setResults(null)
      setSearching(false)
      setError(null)
      return
    }

    setSearching(true)
    const id = (requestId.current += 1)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const found = await bridge().conversations.search({ query: trimmed, limit: LIMIT })
          if (requestId.current !== id) return
          setResults(found)
          setError(null)
        } catch (thrown) {
          if (requestId.current !== id) return
          setResults([])
          setError(errorMessage(thrown))
        } finally {
          if (requestId.current === id) setSearching(false)
        }
      })()
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [trimmed])

  // A new query means a new best hit; selection returns to the top.
  useEffect(() => {
    setActiveIndex(0)
  }, [trimmed])

  const rows = results ?? []
  const clampedIndex = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1)

  useLayoutEffect(() => {
    if (clampedIndex < 0) return
    rowRefs.current.get(clampedIndex)?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex, rows])

  /**
   * `SearchResult` is denormalized for durability — it carries the author's name
   * and accent so a hit survives a Bot being renamed or deleted — but not the
   * avatar shape. Resolving the live Bot by name restores the real avatar when
   * the Bot still exists, and the accent alone carries it when it does not.
   */
  const botsByName = useMemo(() => {
    const map = new Map<string, Bot>()
    for (const bot of Object.values(bots)) map.set(bot.name.toLowerCase(), bot)
    return map
  }, [bots])

  const open = useCallback(
    (result: SearchResult) => {
      const app = useAppStore.getState()
      const ui = useUiStore.getState()
      // setActive() clears any pending jump, so it has to happen first.
      ui.setActive(result.conversationId)
      void app.loadMessages(result.conversationId)
      void app.markRead(result.conversationId)
      ui.jumpTo(result.messageId)
      onClose()
    },
    [onClose]
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (rows.length === 0) {
        if (e.key === 'Enter') e.preventDefault()
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((clampedIndex + 1) % rows.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((clampedIndex - 1 + rows.length) % rows.length)
          break
        case 'Home':
          e.preventDefault()
          setActiveIndex(0)
          break
        case 'End':
          e.preventDefault()
          setActiveIndex(rows.length - 1)
          break
        case 'Enter': {
          e.preventDefault()
          const result = rows[clampedIndex]
          if (result) open(result)
          break
        }
        default:
          break
      }
    },
    [clampedIndex, open, rows]
  )

  const listId = 'ccb-search-list'
  const activeResult = clampedIndex >= 0 ? rows[clampedIndex] : undefined

  return (
    <PaletteShell label="Search messages" onClose={onClose}>
      <PaletteInput
        value={query}
        onChange={setQuery}
        onKeyDown={onKeyDown}
        placeholder="Search every message…"
        listId={listId}
        activeId={activeResult ? `${listId}-${activeResult.messageId}` : undefined}
      />

      <div
        id={listId}
        role="listbox"
        aria-label="Search results"
        aria-busy={searching || undefined}
        className="scroller min-h-0 flex-1 overflow-y-auto"
        style={{ padding: 6, scrollPaddingBlock: 6 }}
      >
        {trimmed.length === 0 ? (
          <Placeholder
            title="Search your Bot history"
            body="Every message from you and from your Bots, across every conversation. Opening a result jumps to that exact message."
          />
        ) : searching && results === null ? (
          <SearchSkeleton />
        ) : error ? (
          <Placeholder title="Search is unavailable" body={error} tone="danger" />
        ) : rows.length === 0 ? (
          <Placeholder
            title={`No messages match “${trimmed}”`}
            body="Try a single distinctive word — search matches whole words, and the last one you type is matched as a prefix."
          />
        ) : (
          rows.map((result, index) => (
            <ResultRow
              key={result.messageId}
              id={`${listId}-${result.messageId}`}
              result={result}
              bot={result.authorName ? botsByName.get(result.authorName.toLowerCase()) : undefined}
              selected={index === clampedIndex}
              onActivate={() => open(result)}
              onHover={() => setActiveIndex(index)}
              registerRef={(node) => {
                if (node) rowRefs.current.set(index, node)
                else rowRefs.current.delete(index)
              }}
            />
          ))
        )}
      </div>

      <PaletteFooter>
        <PaletteHint keys={['up', 'down']} label="Navigate" />
        <PaletteHint keys="enter" label="Jump to message" />
        <PaletteHint keys="escape" label="Close" />
        <span className="flex-1" />
        {rows.length > 0 ? (
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}>
            {rows.length === LIMIT
              ? `${LIMIT}+ matches`
              : `${rows.length} ${rows.length === 1 ? 'match' : 'matches'}`}
          </span>
        ) : null}
      </PaletteFooter>
    </PaletteShell>
  )
}

/* ------------------------------------------------------------------ *
 * Result row
 * ------------------------------------------------------------------ */

/** A 24px stand-in for the two authors that are not Bots. */
function NonBotAvatar({ kind }: { kind: 'user' | 'system' }): ReactElement {
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{
        width: 24,
        height: 24,
        borderRadius: 'var(--r-full)',
        background: 'var(--surface-2)',
        color: 'var(--fg-tertiary)'
      }}
      aria-hidden
    >
      {kind === 'user' ? (
        <User size={14} strokeWidth={1.75} />
      ) : (
        <Info size={14} strokeWidth={1.75} />
      )}
    </span>
  )
}

function ResultRow({
  id,
  result,
  bot,
  selected,
  onActivate,
  onHover,
  registerRef
}: {
  id: string
  result: SearchResult
  bot: Bot | undefined
  selected: boolean
  onActivate(): void
  onHover(): void
  registerRef(node: HTMLDivElement | null): void
}): ReactElement {
  /* The snippet arrives with U+0001 / U+0002 around each hit instead of markup,
     so the matched runs are rebuilt as real elements. Never innerHTML: a message
     body containing markup would otherwise be interpreted by the search UI.

     `plainTextSnippet` runs FIRST, on the whole snippet: the index is built over
     `body_markdown`, so hits used to arrive with their syntax attached and this
     was the one surface in the app that printed literal `**` and backticks. It
     has to happen before the split, because a delimiter PAIR can straddle a
     sentinel (`**` before a hit, its partner after it) and stripping each part
     on its own would leave one of them behind. The strip cannot touch the
     sentinels themselves, so the pairing survives it. */
  const parts = useMemo(
    () => splitMatchSentinels(plainTextSnippet(result.snippetHtmlSafe)),
    [result.snippetHtmlSafe]
  )

  const authorLabel =
    result.authorType === 'user' ? 'You' : (result.authorName ?? (result.authorType === 'system' ? 'System' : 'Bot'))

  const TypeIcon = result.conversationType === 'group' ? Users : MessageCircle

  return (
    <div
      ref={registerRef}
      id={id}
      role="option"
      aria-selected={selected}
      data-selected={selected || undefined}
      onClick={onActivate}
      onMouseMove={onHover}
      className="row-pill flex items-start"
      style={{ padding: '9px 12px', gap: 10, minHeight: 62 }}
    >
      <span className="shrink-0" style={{ paddingTop: 1 }}>
        {result.authorType === 'bot' ? (
          <BotAvatar
            bot={bot}
            name={result.authorName ?? ''}
            size={24}
            accent={bot ? undefined : (result.authorAccent ?? undefined)}
          />
        ) : (
          <NonBotAvatar kind={result.authorType === 'user' ? 'user' : 'system'} />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <span className="flex min-w-0 items-center" style={{ gap: 6 }}>
          <TypeIcon
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0"
            style={{ color: 'var(--fg-tertiary)' }}
          />
          <span
            className="truncate"
            style={{
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              letterSpacing: 'var(--ls-meta)',
              fontWeight: 550,
              color: selected ? 'var(--fg-primary)' : 'var(--fg-secondary)'
            }}
          >
            {result.conversationName}
          </span>
          <span
            className="shrink-0 truncate"
            style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-tertiary)', maxWidth: 140 }}
          >
            {authorLabel}
          </span>
          <span className="flex-1" />
          <span
            className="shrink-0"
            style={{ fontSize: 'var(--fs-micro)', color: 'var(--fg-quaternary)' }}
          >
            {formatRelativeShort(result.createdAt)}
          </span>
        </span>

        <span
          className="selectable"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            color: 'var(--fg-tertiary)'
          }}
        >
          {parts.map((part, index) =>
            part.match ? (
              <mark
                key={index}
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  borderRadius: 'var(--r-2)',
                  padding: '0 2px'
                }}
              >
                {collapse(part.text)}
              </mark>
            ) : (
              <span key={index}>{collapse(part.text)}</span>
            )
          )}
        </span>
      </span>
    </div>
  )
}

/** Transcript text is multi-line; a result row is one clamped paragraph. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/* ------------------------------------------------------------------ *
 * Empty / loading
 * ------------------------------------------------------------------ */

function Placeholder({
  title,
  body,
  tone = 'default'
}: {
  title: string
  body: string
  tone?: 'default' | 'danger'
}): ReactElement {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{ padding: '38px 28px', gap: 8 }}
    >
      <Search
        size={20}
        strokeWidth={1.5}
        aria-hidden
        style={{ color: 'var(--fg-quaternary)', marginBottom: 2 }}
      />
      <p
        style={{
          fontSize: 'var(--fs-chrome)',
          lineHeight: 'var(--lh-chrome)',
          fontWeight: 550,
          color: tone === 'danger' ? 'var(--fg-danger)' : 'var(--fg-primary)'
        }}
      >
        {title}
      </p>
      <p
        style={{
          maxWidth: 360,
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          color: 'var(--fg-tertiary)'
        }}
      >
        {body}
      </p>
    </div>
  )
}

/** 24px avatar + 9px of padding above and below it. */
const SKELETON_ROW_HEIGHT = 42

/**
 * The skeleton mirrors the real row exactly — 24px avatar, a title line, two
 * snippet lines — because a placeholder that does not match what lands is worse
 * than none. `Skeleton` delays itself 250ms internally, so a fast local FTS query
 * never flashes one.
 *
 * That delay is why the container reserves the four rows' height up front: the
 * palette sizes itself to its content, and for those 250ms `Skeleton` renders
 * nothing at all, so an unreserved list collapsed to a sliver and the panel
 * snapped shut and open again before the results landed.
 */
function SearchSkeleton(): ReactElement {
  return (
    <div aria-hidden style={{ minHeight: 4 * SKELETON_ROW_HEIGHT }}>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-start" style={{ padding: '9px 12px', gap: 10 }}>
          <Skeleton width={24} height={24} radius="var(--r-full)" index={row} />
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 7, paddingTop: 3 }}>
            <Skeleton width={`${34 + ((row * 11) % 22)}%`} height={10} index={row} />
            <Skeleton width={`${72 + ((row * 9) % 24)}%`} height={9} index={row} />
          </div>
        </div>
      ))}
    </div>
  )
}
