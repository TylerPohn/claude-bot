import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Grow a textarea with its content up to `maxHeight`, then let it scroll.
 *
 * MEASURE A MIRROR IF THERE IS ONE, AND NEVER COLLAPSE THE LIVE FIELD.
 * `scrollHeight` on a box that is already taller than its content reports the
 * *current* height, so measuring the field itself means first shrinking it with
 * `height: auto` — and a textarea's auto height is one row, not its content.
 * That collapse is a real, if invisible, layout state: in the composer it handed
 * the transcript above ~150px of extra height for the duration of one layout
 * effect. When the whole conversation fitted inside that taller viewport
 * (`minHeight: 100%` on the transcript column means `scrollHeight` tracks
 * `clientHeight`) the maximum scroll offset became 0, Chromium clamped
 * `scrollTop` to 0, and restoring the height did NOT restore the offset. The
 * transcript jumped to the top on every keystroke of a multi-line draft and
 * never came back: the resize nets to zero within the frame, so the stick-to-
 * bottom ResizeObserver never fires and nothing re-pins. Measuring an
 * off-screen mirror that already renders the same text at the same metrics
 * costs no reflow of the field at all.
 *
 * `measureRef` is optional because this hook is also used by the plain
 * `Textarea` in forms, which has no mirror and no scroller above it; those fall
 * back to the collapse.
 *
 * Runs in a layout effect so the resize lands in the same frame as the keystroke
 * — in a passive effect the pill visibly lags one frame behind the caret.
 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = 198,
  measureRef?: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const mirror = measureRef?.current
    let content: number
    if (mirror) {
      content = mirror.scrollHeight
    } else {
      el.style.height = 'auto'
      content = el.scrollHeight
    }

    el.style.height = `${Math.min(content, maxHeight)}px`
    // Decided by the height we MEASURED. Re-reading `el.scrollHeight` here
    // happens to agree when the field was measured, but it is meaningless on the
    // mirror path — nothing was written to the field to read back.
    el.style.overflowY = content > maxHeight ? 'auto' : 'hidden'
  }, [ref, value, maxHeight, measureRef])
}
