import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode
} from 'react'
import { ArrowDown } from 'lucide-react'

import type { Message } from '@shared/types'
import { cn } from '@/lib/cn'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Skeleton } from '@/components/ui/Skeleton'
import { Spinner } from '@/components/ui/Spinner'
import { contentColumnStyle, publishScrollbarGutter } from './contentColumn'
import { DaySeparator } from './DaySeparator'
import { MessageRow } from './MessageRow'

/**
 * The transcript.
 *
 * SCROLLING (DESIGN §6, every item deliberate):
 *  - `useStickToBottom` owns the scroll position: a spring, driven by a
 *    ResizeObserver on the content element, because streaming text changes the
 *    scrollable height without ever firing a scroll event.
 *  - `overflow-anchor: none` on every message plus a zero-height trailing anchor
 *    with `overflow-anchor: auto`. Chromium's own anchoring is a useful safety
 *    net for non-streaming inserts but a fight with the spring during one.
 *  - NO `flex-direction: column-reverse`: it inverts DOM order, breaks
 *    scroll-to-message maths, and makes selection and find-in-page behave oddly.
 *  - NO `content-visibility: auto`: it substitutes estimated sizes for offscreen
 *    elements, which mutates `scrollHeight` — exactly the number the spring
 *    depends on.
 *  - `overscroll-behavior: contain` (via `.scroller`) to stop scroll chaining.
 *    Horizontal-only scrollers INSIDE the transcript (code blocks, tables) opt
 *    out on the vertical axis, or they swallow the wheel instead of chaining.
 *  - The content column is `min-height: 100%` with `margin-top: auto` on the
 *    first item of the message list, so a two-message conversation sits ON the
 *    composer the way every messenger does instead of hanging under the header
 *    with 450px of dead ground below it. The auto margin resolves to 0 as soon
 *    as the content overflows, so it is inert on a real transcript, and it is
 *    scoped to the messages branch so the centred empty state does not move.
 *
 * KEYBOARD (a11y): the rows carry a ROVING tab index and the per-message action
 * buttons are `tabIndex={-1}`. With every bar in the sequential order a
 * 160-message transcript put 724 tab stops before the composer and forward
 * tabbing never terminated, because scrolling old rows into view paged in more
 * history. Tab now goes log → active row → composer; ↑/↓ move between rows and
 * → moves into the focused row's action bar.
 *
 * GROUPING: runs of consecutive messages by one author are visually joined (4px
 * gap inside a run, 12px across runs) and, in a group chat, carry one avatar and
 * one name for the whole run.
 */

/** A separator is inserted across a day boundary and after a long quiet gap. */
const SESSION_GAP_MS = 60 * 60 * 1000
/** A run also breaks when the same author resumes much later. */
const RUN_GAP_MS = 7 * 60 * 1000
/** How many extra pages a jump-to-message may pull in while hunting a target. */
const MAX_JUMP_PAGES = 5

/**
 * What "Load earlier messages" captured so the reading position survives the
 * prepend. Keyed to the CONVERSATION and to the head message, because this
 * component is not remounted per conversation and because an unrelated store
 * update must not be mistaken for the load landing.
 */
interface PrependAnchor {
  conversationId: string
  /** Head message at capture time; the prepend is precisely what changes it. */
  headId: string | null
  /** A row that was on screen, and its offset from the scroller's top edge. */
  anchorId: string | null
  anchorOffset: number
  /** Fallback when there was no row to anchor on. */
  height: number
  top: number
}

interface RenderItem {
  message: Message
  separatorAt: string | null
  runStart: boolean
  runEnd: boolean
  gapTop: number
}

function sameAuthor(a: Message, b: Message): boolean {
  if (a.authorType !== b.authorType) return false
  return a.authorBotId === b.authorBotId
}

function buildItems(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = []

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    const previous = i > 0 ? messages[i - 1]! : null
    const next = i + 1 < messages.length ? messages[i + 1]! : null

    const at = new Date(message.createdAt).getTime()
    const previousAt = previous ? new Date(previous.createdAt).getTime() : 0

    const newDay =
      previous === null ||
      new Date(message.createdAt).toDateString() !== new Date(previous.createdAt).toDateString()
    // The separator format carries a time (`Today 7:58 AM`), which is only
    // meaningful if it also marks the start of a fresh session inside one day.
    const longGap = previous !== null && at - previousAt > SESSION_GAP_MS
    const separatorAt = newDay || longGap ? message.createdAt : null

    const runStart =
      separatorAt !== null ||
      previous === null ||
      previous.authorType === 'system' ||
      message.authorType === 'system' ||
      !sameAuthor(previous, message) ||
      at - previousAt > RUN_GAP_MS

    const nextAt = next ? new Date(next.createdAt).getTime() : 0
    const runEnd =
      next === null ||
      next.authorType === 'system' ||
      message.authorType === 'system' ||
      !sameAuthor(message, next) ||
      nextAt - at > RUN_GAP_MS ||
      new Date(next.createdAt).toDateString() !== new Date(message.createdAt).toDateString() ||
      nextAt - at > SESSION_GAP_MS

    items.push({
      message,
      separatorAt,
      runStart,
      runEnd,
      // The separator supplies its own spacing, so a run opening under one gets 0.
      gapTop: separatorAt !== null || previous === null ? 0 : runStart ? 12 : 4
    })
  }

  return items
}

export interface MessageListProps {
  conversationId: string
  isGroup: boolean
  /** Rendered centred when the conversation has no messages at all. */
  emptyState?: ReactNode
}

export function MessageList({
  conversationId,
  isGroup,
  emptyState
}: MessageListProps): ReactElement {
  const messages = useAppStore((state) => state.messages[conversationId])
  const pagination = useAppStore((state) => state.pagination[conversationId])
  const viewportWidth = useUiStore((state) => state.viewportWidth)
  const jumpToMessageId = useUiStore((state) => state.jumpToMessageId)

  const {
    scrollRef,
    contentRef,
    isAtBottom,
    isNearBottom,
    scrollToBottom,
    scrollToElement,
    scrollToOffset
  } = useStickToBottom([conversationId])

  const [hasNew, setHasNew] = useState(false)
  const [activeRowId, setActiveRowId] = useState<string | null>(null)
  // Tagged with the conversation it was taken from: this component is not keyed
  // by id, so a bare ref would carry the previous conversation's last message
  // into the next one and announce "New messages" about the switch itself.
  const lastSeenRef = useRef<{ conversationId: string; id: string | null } | null>(null)
  const restoreRef = useRef<PrependAnchor | null>(null)
  const jumpAttemptsRef = useRef<{ id: string; pages: number }>({ id: '', pages: 0 })

  const items = useMemo(() => buildItems(messages ?? []), [messages])
  const rowIds = useMemo(() => items.map((item) => item.message.id), [items])

  // Exactly one row is a tab stop. Until the user picks one it is the newest
  // message — the one they are already looking at.
  const activeRowIndex = activeRowId === null ? -1 : rowIds.indexOf(activeRowId)
  const activeRow = activeRowIndex === -1 ? (rowIds[rowIds.length - 1] ?? null) : activeRowId

  // The scroller is the only element that can measure the width
  // `scrollbar-gutter: stable both-edges` reserves, and the composer dock needs
  // that number to land on the same edges (contentColumn.ts). A layout effect so
  // the dock never paints a frame with a stale value; re-run on width changes
  // because that is when a mismatch would be visible.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element) publishScrollbarGutter(element)
  }, [scrollRef, viewportWidth])

  /* ---- remember where the user was in each conversation ------------- */

  // Recorded from a scroll listener rather than during render. React commits the
  // NEXT conversation's render before it runs this effect's cleanup, so anything
  // captured in the render body already belongs to the conversation being opened
  // — the position of the one being left is gone by then. The listener closes
  // over the right id, and the cleanup only trusts a ref that still matches it.
  const rememberRef = useRef<{ id: string; offset: number; atBottom: boolean } | null>(null)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const record = (): void => {
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
      rememberRef.current = {
        id: conversationId,
        offset: element.scrollTop,
        // Matches the hook's own AT_BOTTOM threshold: "close enough to the
        // bottom" must mean the same thing in both places, or a conversation
        // the user never scrolled would be restored a few pixels off it.
        atBottom: remaining <= 70
      }
    }

    record()
    element.addEventListener('scroll', record, { passive: true })
    return () => {
      element.removeEventListener('scroll', record)
      const remembered = rememberRef.current
      if (!remembered || remembered.id !== conversationId) return
      useUiStore.getState().rememberScroll(conversationId, remembered.atBottom ? null : remembered.offset)
    }
  }, [conversationId, scrollRef])

  // Restore in a LAYOUT effect so the user never sees a frame at the bottom
  // first. Runs once per conversation, after its first page is in the DOM.
  const restoredForRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (restoredForRef.current === conversationId) return
    if (!messages || messages.length === 0) return
    restoredForRef.current = conversationId
    const remembered = useUiStore.getState().scrollOffsets[conversationId]
    if (remembered === undefined || remembered <= 0) return
    const element = scrollRef.current
    if (!element) return
    // The remembered offset was measured against a page set that may since have
    // been trimmed, so clamp rather than trusting it blindly.
    scrollToOffset(Math.min(remembered, Math.max(0, element.scrollHeight - element.clientHeight)))
  }, [conversationId, messages, scrollRef, scrollToOffset])

  /* ---- "there is something new below" ------------------------------ */

  useEffect(() => {
    // Nothing has been rendered for this conversation yet: wait for its first
    // page rather than treating "undefined" as a state worth remembering.
    if (messages === undefined) return

    const lastId = messages[messages.length - 1]?.id ?? null
    const seen = lastSeenRef.current

    if (seen === null || seen.conversationId !== conversationId) {
      // First look at this conversation. Whatever is at the bottom right now is
      // NOT news — the user was reading it when they switched away. Seeding here
      // is what stopped re-entry lighting up "New messages" about a message they
      // had already seen.
      lastSeenRef.current = { conversationId, id: lastId }
      if (hasNew) setHasNew(false)
      return
    }

    if (lastId !== seen.id) {
      lastSeenRef.current = { conversationId, id: lastId }
      if (!isAtBottom && lastId !== null) setHasNew(true)
    }
    if (isAtBottom && hasNew) setHasNew(false)
  }, [messages, isAtBottom, hasNew, conversationId])

  /* ---- load older, preserving the reading position ------------------ */

  const requestOlder = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const state = useAppStore.getState()
    const page = state.pagination[conversationId]
    if (!page || page.loading || !page.hasMore) return

    // Capture BEFORE the fetch, anchored on an ELEMENT rather than on
    // `scrollHeight`. A live turn hands this list a fresh array ~30 times a
    // second and each of those can change the total height between the capture
    // and the prepend; measuring where a row that is actually on screen ends up
    // is immune to every one of them, including the streaming message below the
    // fold growing while the page is in flight.
    const containerTop = element.getBoundingClientRect().top
    let anchorId: string | null = null
    let anchorOffset = 0
    for (const row of element.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > containerTop) {
        anchorId = row.dataset.messageId ?? null
        anchorOffset = rect.top - containerTop
        break
      }
    }

    restoreRef.current = {
      conversationId,
      headId: state.messages[conversationId]?.[0]?.id ?? null,
      anchorId,
      anchorOffset,
      height: element.scrollHeight,
      top: element.scrollTop
    }

    void state.loadOlder(conversationId)
    // `loadOlder` silently refuses a request it cannot make (no cursor). Nothing
    // will be prepended, so the capture must not outlive this call and get spent
    // on some later load.
    if (!useAppStore.getState().pagination[conversationId]?.loading) restoreRef.current = null
  }, [conversationId, scrollRef])

  useLayoutEffect(() => {
    const element = scrollRef.current
    const restore = restoreRef.current
    if (!element || !restore) return
    // Left over from another conversation: this component is not keyed by id, so
    // the ref survives a switch.
    if (restore.conversationId !== conversationId) {
      restoreRef.current = null
      return
    }

    // KEYED TO THE PREPEND, NOT TO A RENDER. This effect used to clear the
    // capture on every new `messages` array, so a single `message:delta` landing
    // during the `getMessages` round trip — near certain while a Bot streams —
    // spent the compensation, and the page of history was then inserted above
    // the reader with none: the view snapped backwards by a full page.
    const head = messages?.[0]?.id ?? null
    if (head === restore.headId) return
    restoreRef.current = null

    const anchor = restore.anchorId
      ? element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(restore.anchorId)}"]`)
      : null
    if (anchor) {
      const offset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
      const moved = offset - restore.anchorOffset
      if (moved !== 0) element.scrollTop += moved
      return
    }

    // Nothing was on screen to anchor on (the list was empty or still a
    // skeleton): fall back to the height difference.
    const delta = element.scrollHeight - restore.height
    if (delta > 0) element.scrollTop = restore.top + delta
  }, [messages, conversationId, scrollRef])

  // A load that ends WITHOUT prepending — the request failed, or every message
  // in the page was already present — must not strand the capture for the next
  // load to spend. `loadOlder` always clears `pagination.loading` on the way out,
  // success or failure, so that transition is the signal. Declared after the
  // effect above so a successful prepend is compensated first.
  useLayoutEffect(() => {
    if (pagination?.loading !== false) return
    restoreRef.current = null
  }, [pagination?.loading])

  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = sentinelRef.current
    const root = scrollRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestOlder()
      },
      { root, rootMargin: '320px 0px 0px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [requestOlder, scrollRef, pagination?.hasMore])

  /* ---- jump to a specific message (search hits, notifications) ------- */

  useEffect(() => {
    if (!jumpToMessageId) return
    const content = contentRef.current
    if (!content) return

    if (jumpAttemptsRef.current.id !== jumpToMessageId) {
      jumpAttemptsRef.current = { id: jumpToMessageId, pages: 0 }
    }

    const target = content.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(jumpToMessageId)}"]`
    )

    if (target) {
      // NOT `scrollIntoView`: a jump has to BREAK the stick-to-bottom lock. The
      // transcript opens pinned to the bottom with the follow spring live, so a
      // raw scroll was simply sprung back to the newest message and the flash
      // played off screen — every single time, since that is the state a
      // conversation opens in. `scrollToElement` marks the user as escaped and
      // stops the spring before it moves.
      scrollToElement(target)
      // Restart the flash even when the same hit is chosen twice in a row.
      target.classList.remove('hit-flash')
      void target.offsetWidth
      target.classList.add('hit-flash')
      const timer = window.setTimeout(() => target.classList.remove('hit-flash'), 1400)
      useUiStore.getState().clearJump()
      return () => window.clearTimeout(timer)
    }

    // The hit is older than the loaded page — pull more history and try again
    // when the store updates, but never walk the whole transcript.
    const page = useAppStore.getState().pagination[conversationId]
    if (page?.hasMore && !page.loading && jumpAttemptsRef.current.pages < MAX_JUMP_PAGES) {
      jumpAttemptsRef.current.pages += 1
      requestOlder()
    } else if (!page?.hasMore) {
      useUiStore.getState().clearJump()
    }
    return
  }, [jumpToMessageId, messages, conversationId, contentRef, requestOlder, scrollToElement])

  /* ---- roving focus over the rows (a11y) ---------------------------- */

  const focusRow = useCallback(
    (id: string) => {
      setActiveRowId(id)
      const element = scrollRef.current
      element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)?.focus()
    },
    [scrollRef]
  )

  const onRowFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>): void => {
    // ONLY A DELIBERATE ROW FOCUS MOVES THE ROVING ANCHOR — the identity check
    // is the whole point. This handler is wired to the CONTAINER, so React's
    // focusin delegation feeds it every focus that bubbles out of a bubble's
    // internals, and it used to walk `closest('[data-message-id]')` up from
    // there. A row precedes its own children in DOM order, so focusing a code
    // block's "Copy code", an activity card's disclosure or a reaction chip
    // dragged the single `tabIndex={0}` BACKWARDS onto a row Tab had already
    // walked past — and forward Tab then never landed on a message at all in any
    // transcript containing one of those, i.e. most of them. The → action bar
    // (Add reaction / Reply / Copy / Ask again / Delete) had no keyboard entry.
    //
    // Clicking a bubble still focuses the row itself (a `tabindex="-1"` div is
    // click-focusable) and `focusRow` focuses it directly, so both still set the
    // anchor; `onRowKeyDown` reads the row out of the DOM, so the arrow model is
    // untouched.
    const id = (event.target as HTMLElement).dataset?.messageId
    if (id) setActiveRowId(id)
  }, [])

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      const row = target.closest<HTMLElement>('[data-message-id]')
      if (!row) return
      const bar = target.closest<HTMLElement>('.msg-actions')
      const index = row.dataset.messageId ? rowIds.indexOf(row.dataset.messageId) : -1

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Only from the row itself or from its action bar — a link or a code
        // block inside a bubble keeps whatever the arrows normally do there. And
        // only when the row was reached by KEYBOARD: clicking a bubble focuses
        // it too, and a mouse user pressing ↓ still expects the transcript to
        // scroll.
        if (bar === null && (target !== row || !row.matches(':focus-visible'))) return
        if (index === -1) return
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1
        if (next < 0 || next >= rowIds.length) return
        event.preventDefault()
        focusRow(rowIds[next]!)
        return
      }

      const buttons = bar ? Array.from(bar.querySelectorAll<HTMLButtonElement>('button')) : []

      if (event.key === 'ArrowRight') {
        if (target === row) {
          const first = row.querySelector<HTMLButtonElement>('.msg-actions button')
          if (!first) return
          event.preventDefault()
          first.focus()
          return
        }
        const at = buttons.indexOf(target as HTMLButtonElement)
        if (at === -1) return
        event.preventDefault()
        buttons[(at + 1) % buttons.length]!.focus()
        return
      }

      if (event.key === 'ArrowLeft') {
        const at = buttons.indexOf(target as HTMLButtonElement)
        if (at === -1) return
        event.preventDefault()
        // Stepping off the left edge of the bar returns to the message itself.
        if (at === 0) row.focus()
        else buttons[at - 1]!.focus()
        return
      }

      if (event.key === 'Escape' && bar) {
        event.preventDefault()
        event.stopPropagation()
        row.focus()
      }
    },
    [focusRow, rowIds]
  )

  /* ---- render ------------------------------------------------------- */

  const loadingFirstPage = messages === undefined || (pagination?.loading && messages.length === 0)
  const showEmpty = !loadingFirstPage && items.length === 0

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation transcript"
        tabIndex={0}
        onFocus={onRowFocus}
        onKeyDown={onRowKeyDown}
        className={cn(
          'scroller transcript h-full overflow-y-auto',
          // The list itself is focusable so a keyboard user can tell they are
          // about to arrow through the transcript rather than the sidebar.
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring-color)]'
        )}
        // Reserve the classic scrollbar's width on BOTH sides, always. Without
        // it the 11px scrollbar that appears the moment a conversation overflows
        // shifts this centred column 5.5px left, so the transcript and the
        // composer — which has no scrollbar — slid in and out of register as the
        // transcript grew.
        style={{ scrollbarGutter: 'stable both-edges' }}
      >
        <div
          ref={contentRef}
          className="flex flex-col"
          style={{
            // Shared with the composer dock; see contentColumn.ts.
            ...contentColumnStyle(viewportWidth),
            paddingTop: 16,
            paddingBottom: 24,
            // Half of the bottom anchoring (the other half is the sentinel's
            // `marginTop: auto`): the column has to be able to fill the scroller
            // before there is any free space for that auto margin to absorb.
            // Harmless once the transcript overflows.
            minHeight: '100%'
          }}
        >
          {loadingFirstPage ? <TranscriptSkeleton /> : null}

          {showEmpty ? (
            <div className="flex min-h-[60vh] flex-col justify-center">{emptyState}</div>
          ) : null}

          {!loadingFirstPage && items.length > 0 ? (
            <>
              {/* `marginTop: auto` bottom-anchors a transcript that does not
                  fill the viewport: a two-message conversation rises off the
                  composer instead of hanging under the header above 450px of
                  dead ground. It is scoped to this branch on purpose — putting
                  `justify-content: flex-end` on the column instead also sinks
                  the centred zero-message empty state by 164px. Once the content
                  overflows there is no free space and the margin resolves to 0,
                  so the sentinel stays at the top of the content and its
                  "load older" IntersectionObserver is unaffected. */}
              <div ref={sentinelRef} aria-hidden style={{ height: 1, marginTop: 'auto' }} />

              {pagination?.hasMore ? (
                <div className="flex justify-center" style={{ padding: '4px 0 12px' }}>
                  {pagination.loading ? (
                    <Spinner size={14} />
                  ) : (
                    <button
                      type="button"
                      onClick={requestOlder}
                      className="text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
                      style={{ fontSize: 'var(--fs-meta)', fontWeight: 550 }}
                    >
                      Load earlier messages
                    </button>
                  )}
                </div>
              ) : null}

              {items.map((item) => (
                <div key={item.message.id} style={{ overflowAnchor: 'none' }}>
                  {item.separatorAt ? <DaySeparator at={item.separatorAt} /> : null}
                  <MessageRow
                    message={item.message}
                    isGroup={isGroup}
                    runStart={item.runStart}
                    runEnd={item.runEnd}
                    gapTop={item.gapTop}
                    rowTabIndex={item.message.id === activeRow ? 0 : -1}
                  />
                </div>
              ))}
            </>
          ) : null}

          {/* Zero-height anchor: a cheap safety net for non-streaming inserts,
              and the one element allowed to participate in scroll anchoring. */}
          <div aria-hidden style={{ height: 0, overflowAnchor: 'auto' }} />
        </div>
      </div>

      {/* POSITION, not activity. This used to be `!isAtBottom && (hasNew ||
          working)`: `hasNew` only flips when the LAST MESSAGE ID changes, and a
          streamed reply is created as an empty row at the START of the turn and
          then grows in place — so `working` was the only thing holding the pill
          up, and it vanished in the same frame the turn ended. A user who
          scrolled up to re-read something mid-stream was left stranded with the
          answer they asked for below the fold and nothing to click. The ≤320px
          band is true whenever the content does not overflow, so a short
          conversation still shows nothing. */}
      {!isNearBottom ? (
        <div className="pointer-events-none absolute right-0 bottom-[12px] left-0 flex justify-center">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className={cn(
              'pointer-events-auto flex items-center gap-[6px]',
              'transition-[background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
              'hover:bg-[var(--surface-3)] active:scale-[0.98]'
            )}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 'var(--r-full)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-2)',
              boxShadow: 'var(--shadow-medium)',
              fontSize: 'var(--fs-meta)',
              letterSpacing: 'var(--ls-meta)',
              fontWeight: 550,
              animation: 'slide-up-in var(--dur-base) var(--ease-out-quad)'
            }}
          >
            <ArrowDown size={14} strokeWidth={1.75} />
            {/* Keyed on whether there is something unseen, not on whether a bot
                happens to be running: "New messages" about a message the user
                has been staring at for ten seconds is a lie either way round. */}
            {hasNew ? 'New messages' : 'Jump to latest'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The first-page skeleton mirrors the real bubble rhythm — alternating sides,
 * varying widths — so nothing re-flows when the transcript lands. Each Skeleton
 * delays itself 250ms, so a warm conversation never flashes one.
 */
function TranscriptSkeleton(): ReactElement {
  const rows: Array<{ side: 'left' | 'right'; width: number; height: number }> = [
    { side: 'left', width: 62, height: 54 },
    { side: 'right', width: 38, height: 36 },
    { side: 'left', width: 74, height: 80 },
    { side: 'right', width: 30, height: 36 },
    { side: 'left', width: 56, height: 54 }
  ]

  return (
    <div className="flex flex-col" style={{ gap: 12, paddingTop: 24 }}>
      {rows.map((row, index) => (
        <div key={index} className={cn('flex', row.side === 'right' ? 'justify-end' : 'justify-start')}>
          <Skeleton
            width={`${row.width}%`}
            height={row.height}
            radius="var(--r-bubble)"
            index={index}
          />
        </div>
      ))}
    </div>
  )
}
