import type { CSSProperties } from 'react'

/**
 * THE content column — one definition, shared by the transcript and by the
 * composer dock.
 *
 * These two used to compute their own geometry and quietly disagreed.
 * `MessageList` capped its column at `--content-max` AND applied the 24px
 * `--gutter` inside it, giving a 656px column; the dock put its 24px padding on
 * a full-width outer box (where it never bit, the box being far wider than the
 * cap) and then centred a bare `--content-max` inner box, giving a 704px
 * composer. So the send button hung 29.5px outboard of every user bubble and the
 * `+` button 18.5px outboard of every Bot bubble — a stagger on the two most
 * looked-at vertical edges in the app. Below 1100px it was worse: the transcript
 * stepped down to `--content-max-narrow` and the composer did not, for a 66-78px
 * mismatch.
 *
 * In an iMessage-shaped client the composer-to-bubble-column registration is the
 * first alignment a reader checks, so the rule lives here and both callers spread
 * it. Do NOT re-derive the cap or the gutter in either place.
 *
 * (The other half of that registration is `scrollbar-gutter: stable both-edges`
 * on the transcript scroller: a classic scrollbar appearing when the transcript
 * overflows would otherwise shift the centred column 5.5px left and drift the
 * two columns in and out of register as the conversation grows.)
 *
 * THE SCROLLBAR GUTTER IS PART OF THE RULE, NOT A DETAIL OF THE SCROLLER.
 * Reserving it shrinks the box the transcript's column is centred in *before*
 * the cap is applied, so the two columns only landed on the same edges while the
 * cap was the binding constraint. As soon as the chat pane was narrower than
 * cap + both gutters — the details panel inline at 1180px is exactly that case,
 * a 612px pane — the transcript column measured `pane - 22` and the dock
 * measured `pane`, and the composer sat 11px outboard on BOTH edges: the same
 * failure this file exists to prevent, one window width to the left of where it
 * was fixed. Callers outside the scroller therefore pass
 * `reserveScrollbarGutter` and lose the same width off their available space,
 * which keeps the two columns identical at every width and in every details
 * state — including the ones where neither cap bites.
 */

/** Below this width the column steps down to `--content-max-narrow` (DESIGN §2.4). */
export const NARROW_WINDOW = 1100

/**
 * The custom property `publishScrollbarGutter` writes, read back by the dock's
 * `max-width` below. It is a live UA METRIC, not a design token: the space
 * `scrollbar-gutter: stable both-edges` reserves is whatever the platform's
 * `scrollbar-width: thin` scrollbar measures (11px per edge on this Chromium;
 * 0 where the OS uses overlay scrollbars, in which case nothing is reserved and
 * nothing must be subtracted). `--sb-size` is a *styling* value for the legacy
 * `::-webkit-scrollbar` rules and has not decided this width since Chromium 121
 * let `scrollbar-width` supersede them, so it cannot be used here.
 */
const SCROLLBAR_GUTTER_VAR = '--sb-gutter'

/**
 * What the dock assumes until the transcript has measured the real thing. Only
 * ever wrong for the first frame after launch, and only on a platform whose
 * scrollbars are not 11px.
 */
const SCROLLBAR_GUTTER_FALLBACK = 11

/**
 * Publish the transcript scroller's reserved gutter (per edge) for the dock.
 *
 * Called from the scroller's own layout effect because it is the only element
 * that can be measured: `scrollbar-gutter` applies to scroll containers, so the
 * dock cannot ask the same question of itself — setting the property on it
 * reserves nothing and leaves the mismatch exactly as it was.
 */
export function publishScrollbarGutter(scroller: HTMLElement): void {
  const reserved = scroller.offsetWidth - scroller.clientWidth
  if (reserved < 0) return
  // `both-edges` reserves symmetrically, so half of the difference is one edge.
  const perEdge = Math.round((reserved / 2) * 100) / 100
  const root = document.documentElement
  const next = `${perEdge}px`
  // Guarded: writing an unchanged custom property still invalidates style for
  // the whole document, and this runs on every window resize.
  if (root.style.getPropertyValue(SCROLLBAR_GUTTER_VAR) === next) return
  root.style.setProperty(SCROLLBAR_GUTTER_VAR, next)
}

export interface ContentColumnOptions {
  /**
   * Set by callers that are NOT inside the transcript scroller — today, the
   * composer dock. See the file comment: the scroller's stable gutter has to
   * come off the available width on both sides before the cap is applied, or the
   * two columns diverge at every width where the cap does not bite.
   */
  reserveScrollbarGutter?: boolean
}

export function contentColumnStyle(
  viewportWidth: number,
  options: ContentColumnOptions = {}
): CSSProperties {
  const cap = viewportWidth < NARROW_WINDOW ? 'var(--content-max-narrow)' : 'var(--content-max)'
  return {
    // `100% - 2 * gutter` is the transcript scroller's CONTENT box expressed
    // from outside it; `min()` then applies the same cap to the same number the
    // transcript sees. Auto width plus auto margins centres whatever survives.
    maxWidth: options.reserveScrollbarGutter
      ? `min(${cap}, calc(100% - 2 * var(${SCROLLBAR_GUTTER_VAR}, ${SCROLLBAR_GUTTER_FALLBACK}px)))`
      : cap,
    marginInline: 'auto',
    paddingInline: 'var(--gutter)'
  }
}
