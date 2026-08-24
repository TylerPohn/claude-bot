import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Stick-to-bottom for the streaming transcript. This is the single highest-risk
 * piece of UX in the app, so every constant here is from DESIGN §6 and every
 * decision below is deliberate.
 *
 * WHY A SPRING, NOT `scrollIntoView` OR A FIXED EASE.
 * Content height jumps mid-animation while tokens arrive. A fixed-duration ease
 * is retargeted on every jump and visibly stutters; a proportional controller
 * with inertia simply converges on the new target. Per tick:
 *
 *     velocity = (damping * velocity + stiffness * difference) / mass
 *     accumulated += velocity * (tickDelta / (1000 / 60))
 *
 * WHY A ResizeObserver, NOT SCROLL EVENTS OR THE TOKEN STREAM.
 * Growing the content does not fire a scroll event — the scroll position never
 * changed, the scrollable area did. Watching the token stream instead would tie
 * the scroller to one producer and miss images, code blocks and expanding
 * activity cards. The ResizeObserver catches all of them.
 *
 * WHY THREE FLAGS.
 * `isAtBottom` (≤70px) decides whether new content should follow. `isNearBottom`
 * (≤320px) is the softer band used for the "jump to latest" affordance.
 * `escapedFromLock` is the one that stops the app fighting a user who scrolled up
 * to read history: once set, nothing re-engages the follow behaviour until they
 * come back to the bottom themselves (or call `scrollToBottom`).
 *
 * WHY NO DEBOUNCE. Debouncing scroll input drops events, and a dropped "user
 * scrolled up" event is exactly the failure that makes a chat app feel possessed.
 */

/** DESIGN §6: `isAtBottom` threshold. */
const AT_BOTTOM_PX = 70
/** The softer band, for "there's more below" affordances. */
const NEAR_BOTTOM_PX = 320
/** DESIGN §6: programmatic-scroll retention window. */
const PROGRAMMATIC_MS = 350
/** How long after a wheel/touch/mousedown/key a scroll still counts as the user's. */
const GESTURE_MS = 350

const DAMPING = 0.7
const STIFFNESS = 0.05
const MASS = 1.25
const TICK = 1000 / 60

export interface StickToBottom {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  isAtBottom: boolean
  /**
   * The softer ≤320px band. Published separately from `isAtBottom` because a
   * "there is more below" affordance must not appear the moment the follow
   * spring is a few pixels behind a stream, and must not vanish the moment a
   * turn ends.
   */
  isNearBottom: boolean
  scrollToBottom(behavior?: 'smooth' | 'instant'): void
  /**
   * Centre an element in the scroller and BREAK the follow lock, for a jump the
   * user asked for (a search hit, a notification). Anything that moves the
   * scroller behind the hook's back is simply sprung back to the bottom.
   */
  scrollToElement(target: HTMLElement): void
  /**
   * Restore a remembered scroll offset and BREAK the follow lock, so returning
   * to a conversation lands where the user left it rather than at the bottom.
   * A no-op when the offset is already at the bottom.
   */
  scrollToOffset(offset: number): void
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export function useStickToBottom(deps: unknown[]): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isNearBottom, setIsNearBottom] = useState(true)

  const atBottomRef = useRef(true)
  const nearBottomRef = useRef(true)
  const escapedRef = useRef(false)

  const frameRef = useRef<number | null>(null)
  const velocityRef = useRef(0)
  const accumulatedRef = useRef(0)
  const lastTickRef = useRef(0)
  /** Consecutive frames in which the scroller refused to move at all. */
  const stalledFramesRef = useRef(0)

  /** Set while we are the ones moving the scroller. */
  const programmaticUntilRef = useRef(0)
  /** What we last asked `scrollTop` to be, to spot a scroll we did not cause. */
  const expectedTopRef = useRef<number | null>(null)
  /** Last wheel / touch / pointer / arrow-key from the user. */
  const gestureAtRef = useRef(0)

  const reducedMotionRef = useRef(false)

  /**
   * True from the moment a conversation is opened until its content actually
   * ARRIVES. The first page lands over IPC two or more frames after the reset
   * below has already pinned an empty scroller, and the ResizeObserver's only
   * answer to new content is the follow spring — so opening any transcript that
   * overflowed played a 1.3-2s animated scroll from the oldest message down to
   * the newest, on every conversation, once per launch. That page is a LOAD, not
   * a stream: it is pinned instantly.
   */
  const awaitingFirstContentRef = useRef(true)
  /** Previous `scrollHeight`, so the observer can tell growth from a shrink. */
  const lastContentHeightRef = useRef(0)

  const publishAtBottom = useCallback((next: boolean) => {
    if (atBottomRef.current === next) return
    atBottomRef.current = next
    setIsAtBottom(next)
  }, [])

  // Same shape as `publishAtBottom`: the ref is what the hook's own logic reads
  // (a scroll handler that re-rendered on every frame would be the end of the
  // spring), the state is what consumers render from. Writing the ref alone —
  // which is all this band used to do — meant nothing could ever see it.
  const publishNearBottom = useCallback((next: boolean) => {
    if (nearBottomRef.current === next) return
    nearBottomRef.current = next
    setIsNearBottom(next)
  }, [])

  const stopSpring = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    velocityRef.current = 0
    accumulatedRef.current = 0
    stalledFramesRef.current = 0
  }, [])

  /** Move the scroller and mark the move as ours for the retention window. */
  const applyScrollTop = useCallback((el: HTMLElement, top: number) => {
    const clamped = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight))
    programmaticUntilRef.current = performance.now() + PROGRAMMATIC_MS
    expectedTopRef.current = clamped
    el.scrollTop = clamped
  }, [])

  const jumpToBottom = useCallback(
    (el: HTMLElement) => {
      stopSpring()
      applyScrollTop(el, el.scrollHeight - el.clientHeight)
      publishNearBottom(true)
      publishAtBottom(true)
    },
    [applyScrollTop, publishAtBottom, publishNearBottom, stopSpring]
  )

  const tick = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      frameRef.current = null
      return
    }
    // The user took over while we were animating: never fight them.
    if (escapedRef.current) {
      stopSpring()
      return
    }

    const now = performance.now()
    const delta = lastTickRef.current === 0 ? TICK : Math.min(now - lastTickRef.current, 100)
    lastTickRef.current = now

    const difference = distanceFromBottom(el)
    if (difference < 0.5) {
      applyScrollTop(el, el.scrollHeight - el.clientHeight)
      stopSpring()
      publishNearBottom(true)
      publishAtBottom(true)
      return
    }

    velocityRef.current = (DAMPING * velocityRef.current + STIFFNESS * difference) / MASS
    accumulatedRef.current += velocityRef.current * (delta / TICK)

    if (accumulatedRef.current > 0) {
      const before = el.scrollTop
      applyScrollTop(el, before + accumulatedRef.current)
      const moved = el.scrollTop - before
      // CARRY the remainder the browser refused to apply. Zeroing the
      // accumulator here was a real bug: within ~10px of the bottom the
      // per-frame step is a fraction of a pixel (on a 120Hz display ~0.4px), the
      // compositor rounds it away, and throwing the fraction out meant the
      // spring never made progress and never reached `difference < 0.5`. The
      // transcript came to rest 8-9px short of the true bottom with a rAF +
      // scrollTop write burning every frame for the life of the conversation —
      // which is also what dragged a programmatic jump-to-message back.
      accumulatedRef.current = Math.max(0, accumulatedRef.current - moved)
      stalledFramesRef.current = moved > 0 ? 0 : stalledFramesRef.current + 1
      // The spring must always terminate. A second of refusing to move means the
      // target is unreachable at this pixel density: snap and stop.
      if (stalledFramesRef.current > 60) {
        jumpToBottom(el)
        return
      }
    }

    frameRef.current = requestAnimationFrame(tick)
  }, [applyScrollTop, jumpToBottom, publishAtBottom, publishNearBottom, stopSpring])

  const startSpring = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // A JS-driven springing scroll is precisely the vestibular trigger
    // prefers-reduced-motion exists to prevent. CSS cannot reach this, so the
    // preference is read in JS and downgraded to an instant jump.
    if (reducedMotionRef.current) {
      jumpToBottom(el)
      return
    }
    if (frameRef.current !== null) return
    lastTickRef.current = 0
    velocityRef.current = 0
    accumulatedRef.current = 0
    stalledFramesRef.current = 0
    frameRef.current = requestAnimationFrame(tick)
  }, [jumpToBottom, tick])

  const scrollToBottom = useCallback(
    (behavior: 'smooth' | 'instant' = 'smooth') => {
      const el = scrollRef.current
      if (!el) return
      // An explicit request always re-engages the lock.
      escapedRef.current = false
      if (behavior === 'instant' || reducedMotionRef.current) jumpToBottom(el)
      else startSpring()
    },
    [jumpToBottom, startSpring]
  )

  const scrollToElement = useCallback(
    (target: HTMLElement) => {
      const el = scrollRef.current
      if (!el) return
      // A jump the user asked for outranks the follow behaviour. Without
      // `escapedRef` the spring — which is running whenever the transcript is at
      // the bottom, i.e. every time a conversation opens — simply pulled the
      // view back to the newest message and the search hit flashed off screen.
      // The existing `onScroll` handler clears `escapedRef` again the moment the
      // user returns to the bottom, so nothing has to re-engage the lock here.
      escapedRef.current = true
      stopSpring()
      const offset = target.getBoundingClientRect().top - el.getBoundingClientRect().top
      const centring = Math.max(0, (el.clientHeight - target.offsetHeight) / 2)
      // Routed through `applyScrollTop` so the move is recognised as ours: a raw
      // `scrollTop` write sets neither the retention window nor the expected
      // position, and `onScroll` then classifies the jump as nobody's.
      applyScrollTop(el, el.scrollTop + offset - centring)
      const remaining = distanceFromBottom(el)
      publishNearBottom(remaining <= NEAR_BOTTOM_PX)
      // Jumping to a hit that IS at the bottom must not leave the lock broken:
      // `onScroll` normally clears `escapedRef` on arrival, but it never fires
      // when the position did not actually change.
      if (remaining <= AT_BOTTOM_PX) escapedRef.current = false
      publishAtBottom(remaining <= AT_BOTTOM_PX)
    },
    [applyScrollTop, publishAtBottom, publishNearBottom, stopSpring]
  )

  const scrollToOffset = useCallback(
    (offset: number) => {
      const el = scrollRef.current
      if (!el) return
      // Same reasoning as `scrollToElement`: without breaking the lock the
      // spring — which runs from the moment a conversation opens — would drag
      // the view straight back down to the newest message.
      escapedRef.current = true
      stopSpring()
      applyScrollTop(el, offset)
      const remaining = distanceFromBottom(el)
      publishNearBottom(remaining <= NEAR_BOTTOM_PX)
      if (remaining <= AT_BOTTOM_PX) escapedRef.current = false
      publishAtBottom(remaining <= AT_BOTTOM_PX)
    },
    [applyScrollTop, publishAtBottom, publishNearBottom, stopSpring]
  )

  /* ---- reduced motion, read in JS and kept live ---------------------- */
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionRef.current = query.matches
    const onChange = (e: MediaQueryListEvent): void => {
      reducedMotionRef.current = e.matches
      if (e.matches && frameRef.current !== null) {
        const el = scrollRef.current
        if (el) jumpToBottom(el)
      }
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [jumpToBottom])

  /* ---- user-intent detection ----------------------------------------- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const markGesture = (): void => {
      gestureAtRef.current = performance.now()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Only keys that actually move a scroller count as a scroll gesture.
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'PageUp' ||
        e.key === 'PageDown' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        e.key === ' '
      ) {
        markGesture()
      }
    }

    // Passive: none of these are cancelled, and a non-passive wheel listener on
    // the transcript would cost a main-thread round trip per scroll frame.
    el.addEventListener('wheel', markGesture, { passive: true })
    el.addEventListener('touchstart', markGesture, { passive: true })
    el.addEventListener('touchmove', markGesture, { passive: true })
    el.addEventListener('mousedown', markGesture)
    el.addEventListener('keydown', onKeyDown)

    return () => {
      el.removeEventListener('wheel', markGesture)
      el.removeEventListener('touchstart', markGesture)
      el.removeEventListener('touchmove', markGesture)
      el.removeEventListener('mousedown', markGesture)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  /* ---- scroll bookkeeping -------------------------------------------- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const onScroll = (): void => {
      const now = performance.now()
      const difference = distanceFromBottom(el)
      const atBottom = difference <= AT_BOTTOM_PX

      publishNearBottom(difference <= NEAR_BOTTOM_PX)

      // Three signals decide whose scroll this was, exactly as the checklist
      // requires: are we inside the retention window, did the position land
      // where we asked, and did a real input device fire recently.
      const inWindow = now < programmaticUntilRef.current
      const expected = expectedTopRef.current
      const landedWhereAsked = expected !== null && Math.abs(el.scrollTop - expected) <= 2
      const ours = inWindow && landedWhereAsked
      const gestured = now - gestureAtRef.current <= GESTURE_MS

      if (!ours && gestured && !atBottom) {
        // The user pulled away from the bottom: stop following until they
        // choose to come back.
        escapedRef.current = true
        stopSpring()
      }
      if (atBottom) escapedRef.current = false

      publishAtBottom(atBottom)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [publishAtBottom, publishNearBottom, stopSpring])

  /* ---- the driver: content height changes ---------------------------- */
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return

    const observer = new ResizeObserver(() => {
      // Tracked before anything else so it stays true even on the paths that
      // return early: a stale height would make the next callback read a jump
      // in content as growth.
      const height = el.scrollHeight
      const growth = height - lastContentHeightRef.current
      lastContentHeightRef.current = height

      // THE LOCK IS THE ONLY THING THAT DECIDES THIS. It used to additionally
      // require `atBottomRef.current || frameRef.current !== null`, and that was
      // a bug: `atBottomRef` is a MEASUREMENT, and our own layout changes can
      // invalidate it between the jump and the observer. Opening a conversation
      // whose dock then grows — a restored multi-line draft, restored attachment
      // chips, a reply preview, the stop note — shrinks the scroller AFTER
      // `jumpToBottom` has run against the short composer. The clamp that shrink
      // produces fires a scroll event, and scroll events are dispatched BEFORE
      // ResizeObserver delivery in the same frame, so `onScroll` had already
      // published `atBottom: false` by the time this ran. The observer then
      // refused to re-pin: the transcript sat ~150px short of the bottom with
      // the last reply cut mid-sentence, and — worse — the follow lock stayed
      // dead, so the next streamed reply did not track the bottom either.
      if (escapedRef.current) {
        // Something deliberately put the scroller somewhere else during the
        // first commit — a restored offset, a jump to a search hit. Spend the
        // flag here too, or the first STREAMED token later in this conversation
        // would be treated as the arriving page and snap instead of spring.
        awaitingFirstContentRef.current = false
        const distance = distanceFromBottom(el)
        publishAtBottom(distance <= AT_BOTTOM_PX)
        publishNearBottom(distance <= NEAR_BOTTOM_PX)
        return
      }

      // A LOAD, NOT A STREAM: pin it, do not animate to it.
      //
      // Gated on GROWTH rather than on "the first callback" — switching away
      // from a long transcript SHRINKS the content back to the skeleton, which
      // fires the observer, and a first-callback flag would be spent on that
      // shrink and leave the opening animation exactly as it was.
      //
      // The second condition covers what one flag cannot see: any single
      // growth larger than the viewport is a page of history or a late layout
      // (syntax highlighting, an image), never a token. Streamed deltas are tens
      // of pixels, so the follow spring is untouched.
      if (growth > 0 && (awaitingFirstContentRef.current || growth > el.clientHeight)) {
        awaitingFirstContentRef.current = false
        jumpToBottom(el)
        return
      }
      startSpring()
    })

    observer.observe(content)
    // The container resizes too — window resize, details drawer opening.
    observer.observe(el)
    return () => observer.disconnect()
  }, [jumpToBottom, publishAtBottom, publishNearBottom, startSpring])

  /* ---- reset on conversation change ---------------------------------- */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    escapedRef.current = false
    gestureAtRef.current = 0
    // The transcript being rendered right now is a skeleton — the first page is
    // still in flight over IPC — so arm the observer to pin the page when it
    // lands, and record the height it will be compared against.
    awaitingFirstContentRef.current = true
    lastContentHeightRef.current = el.scrollHeight
    // Opening a conversation lands at the newest message with no animation —
    // springing through an entire transcript on open would be absurd.
    jumpToBottom(el)
    // …and again on the next frame, because the dock under the transcript is
    // still settling during this commit: the composer's autosize layout effect
    // runs AFTER this one (ChatView renders the transcript first) and a restored
    // multi-line draft takes up to ~150px off the scroller's height. The
    // ResizeObserver above now recovers from that too, but it recovers by
    // SPRINGING, and a conversation that visibly scrolls itself on open is not
    // what opening a conversation should look like. rAF callbacks run before
    // ResizeObserver delivery in the same frame, so this instant re-pin wins and
    // the observer finds nothing left to do. Skipped if something deliberately
    // put the scroller somewhere else in the meantime — a restored offset or a
    // jump to a message, both of which break the lock.
    const frame = requestAnimationFrame(() => {
      if (escapedRef.current) return
      jumpToBottom(el)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => stopSpring, [stopSpring])

  return {
    scrollRef,
    contentRef,
    isAtBottom,
    isNearBottom,
    scrollToBottom,
    scrollToElement,
    scrollToOffset
  }
}
