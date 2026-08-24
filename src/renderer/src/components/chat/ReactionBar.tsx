import { memo } from 'react'
import type { ReactElement } from 'react'

import type { Reaction } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

/**
 * Reaction chips, overlapping the BOTTOM-LEFT corner of the bubble they belong
 * to (DESIGN §2.4). Two things keep the chip legible: a fill that is a step
 * away from both the bubble and the transcript ground (see below), and the 2px
 * ring in the ground colour that cuts the chip out of the bubble's silhouette
 * on the ~10px where the two overlap.
 *
 * PLACEMENT IS THE CALLER'S. This used to position itself absolutely against
 * the bubble, which put it in a silent fight with the equally absolute hover
 * usage pill — the pill's opaque fill sliced both chips in half. MessageRow now
 * lays the two out side by side in one flex row (see its bubble footer), so all
 * that is left here is the chip row itself.
 *
 * Reactions are local metadata and acknowledgement only. They are never wired to
 * approve, deny or instruct a Bot (RENDERER contract, PRD §19).
 */

export const REACTION_EMOJI = ['👍', '👎', '✅', '👀'] as const

/* ------------------------------------------------------------------ *
 * Chip fill
 *
 * The chip used to be `--surface-2`, which is the SAME token family as the
 * bubble it sits on: byte-identical in dark (#212121 on #212121) and one point
 * apart in light (#f2f2f2 on #f1f2f1). The chip had no body at all — a light
 * theme reaction read as a bare emoji with a thin ring, i.e. a checkbox rather
 * than a chip. `--surface-3` separates from the bubble AND from the transcript
 * ground the chip's lower two-thirds overlaps, in both themes.
 *
 * That collides with the old `hover:bg-[var(--surface-3)]`, which would now be
 * a no-op, so hover layers the translucent `--surface-hover` over the fill
 * instead: one declaration that moves one step lighter on dark and one step
 * darker on light. It has to be a stylesheet rather than an inline style
 * because an inline `background` would outrank the hover rule.
 * ------------------------------------------------------------------ */

const STYLE_ID = 'ccb-reaction-styles'

const REACTION_CSS = `
.reaction-chip { background: var(--surface-3); }
.reaction-chip:hover { background-image: linear-gradient(var(--surface-hover), var(--surface-hover)); }
`

function ensureReactionStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = REACTION_CSS
  document.head.append(style)
}

ensureReactionStyles()

export interface ReactionBarProps {
  messageId: string
  reactions: Reaction[]
}

export const ReactionBar = memo(function ReactionBar({
  messageId,
  reactions
}: ReactionBarProps): ReactElement | null {
  const visible = reactions.filter((reaction) => reaction.count > 0)
  if (visible.length === 0) return null

  return (
    <div
      // The footer row is `pointer-events-none` so it cannot swallow clicks
      // aimed at the bubble above it; the chips are real buttons and opt back in.
      className="pointer-events-auto flex shrink-0 items-center"
      style={{ gap: 4 }}
    >
      {visible.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => void useAppStore.getState().react(messageId, reaction.emoji)}
          aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', added by you' : ''}`}
          aria-pressed={reaction.mine}
          className="reaction-chip no-drag flex shrink-0 items-center transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
          style={{
            height: 22,
            padding: '0 6px',
            gap: 4,
            borderRadius: 'var(--r-full)',
            // The separator ring ONLY (DESIGN §2.4). There used to be an extra
            // inset accent ring under `reaction.mine`, but a chip only exists
            // because this user added it — `rows.ts` builds every Reaction with
            // `mine: true` and the table has no actor column — so the ring was
            // permanent chrome signalling a state that can never vary, and the
            // loudest object in an otherwise greyscale transcript. `aria-pressed`
            // already carries "yours" to assistive tech, honestly.
            boxShadow: '0 0 0 2px var(--surface-0)'
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1, fontFamily: 'var(--font-emoji)' }}>
            {reaction.emoji}
          </span>
          {reaction.count > 1 ? (
            <span
              className="text-[var(--fg-secondary)]"
              style={{ fontSize: 11, fontWeight: 550, fontVariantNumeric: 'tabular-nums' }}
            >
              {reaction.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
})
