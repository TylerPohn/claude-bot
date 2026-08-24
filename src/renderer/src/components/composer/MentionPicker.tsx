import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { Bot } from '@shared/types'
import { BotAvatar, GroupAvatar } from '@/components/ui/BotAvatar'
import type { MentionOption } from './mentionText'

/**
 * The `@` picker (DESIGN §3.6): 320px wide, max-height 280, radius 12,
 * `--surface-3`, `--shadow-medium`, anchored to the CARET and opening upward.
 *
 * The textarea keeps DOM focus the whole time — the picker is a listbox the
 * composer drives through `aria-activedescendant`. Moving focus into the popup
 * would break IME composition and put the caret somewhere the user cannot see.
 */

/**
 * Where a composer picker opens from.
 *
 * HORIZONTALLY it is the trigger character itself, measured off the mirror layer,
 * so the panel sits under the `@` the user typed (DESIGN §3.6).
 *
 * VERTICALLY it is the COMPOSER, not the caret. Anchoring the vertical edge to
 * the caret was a bug: the caret's top is 11px inside the pill's own padding, so
 * `bottom: viewportH - caretTop + GAP` put the panel's bottom edge 3px *below*
 * the pill's top edge — clipping the pill's 22px corner radius and its focus
 * ring — and on a multi-line draft the panel tracks whichever line the caret is
 * on, so at line five it buried four lines of the user's own text. The panel now
 * opens clear of the whole block being composed: the pill plus anything stacked
 * above it (reply preview, attachment chips, the group routing row).
 */
export interface CaretAnchor {
  /** Viewport x of the trigger character. */
  left: number
  /** Top of the composed block; the panel's bottom edge stops GAP above it. */
  composerTop: number
  /** Bottom of the pill, for the flipped-down case. */
  composerBottom: number
}

const PANEL_WIDTH = 320
const PANEL_MAX_HEIGHT = 280
const GAP = 8

/**
 * Shared chrome for both composer pickers. Positioning uses `bottom` rather
 * than `top` so the panel grows upward from the caret with no measure-then-
 * reposition pass — no flash at the wrong place on the first frame.
 */
export function PickerPanel({
  anchor,
  id,
  label,
  children
}: {
  anchor: CaretAnchor
  id: string
  label: string
  children: ReactNode
}): ReactElement {
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
  const viewportW = typeof window === 'undefined' ? 1180 : window.innerWidth

  // Flip below the composer only when there is genuinely no room above it. Both
  // this and the `bottom` below have to measure from the SAME edge, or the
  // max-height overshoots the room the panel is actually given.
  const spaceAbove = anchor.composerTop - GAP
  const flipDown = spaceAbove < 140

  // 16 is the pill's padding-left, so with the `@` at the start of an empty
  // composer — the common case — the panel's left edge is flush with the pill's
  // instead of 4px inboard of it, and the 16px of panel + row padding lines the
  // option names up with the composer's own text. Elsewhere it still follows the
  // `@`.
  const left = Math.min(Math.max(12, anchor.left - 16), Math.max(12, viewportW - PANEL_WIDTH - 12))

  return createPortal(
    <div
      id={id}
      role="listbox"
      aria-label={label}
      className="scroller"
      style={{
        position: 'fixed',
        left,
        ...(flipDown
          ? { top: anchor.composerBottom + GAP }
          : { bottom: Math.max(12, viewportH - anchor.composerTop + GAP) }),
        width: PANEL_WIDTH,
        maxHeight: Math.max(
          120,
          Math.min(PANEL_MAX_HEIGHT, flipDown ? viewportH - anchor.composerBottom - 24 : spaceAbove)
        ),
        overflowY: 'auto',
        zIndex: 'var(--z-popover)',
        background: 'var(--surface-3)',
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--r-popover)',
        boxShadow: 'var(--shadow-medium)',
        padding: 6,
        scrollPaddingBlock: 6,
        animation: 'slide-up-in var(--dur-fast) var(--ease-out-quad)'
      }}
    >
      {children}
    </div>,
    document.body
  )
}

/** 28px group heading — 12px / weight 510 / `--fg-tertiary`. */
export function PickerHeading({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      role="presentation"
      className="flex items-center"
      style={{
        height: 28,
        padding: '0 10px',
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

export function PickerEmpty({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      className="flex items-center"
      style={{ height: 40, padding: '0 10px', fontSize: 'var(--fs-meta)', color: 'var(--fg-tertiary)' }}
    >
      {children}
    </div>
  )
}

export interface MentionPickerProps {
  options: MentionOption[]
  members: Bot[]
  activeIndex: number
  anchor: CaretAnchor
  listId: string
  optionId(index: number): string
  onSelect(option: MentionOption): void
  onHover(index: number): void
}

export function MentionPicker({
  options,
  members,
  activeIndex,
  anchor,
  listId,
  optionId,
  onSelect,
  onHover
}: MentionPickerProps): ReactElement {
  const activeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // `block: 'nearest'` keeps the list still when the row is already visible.
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <PickerPanel anchor={anchor} id={listId} label="Mention a Bot">
      <PickerHeading>Bots</PickerHeading>
      {options.length === 0 ? <PickerEmpty>No matches</PickerEmpty> : null}
      {options.map((option, index) => {
        const active = index === activeIndex
        return (
          <div
            key={option.key}
            id={optionId(index)}
            ref={active ? activeRef : undefined}
            role="option"
            aria-selected={active}
            onMouseMove={() => onHover(index)}
            // mousedown, not click: preventing default keeps the caret and the
            // selection in the textarea, so inserting never loses focus.
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(option)
            }}
            className="flex cursor-default items-center rounded-[8px]"
            style={{
              height: 40,
              padding: '0 10px',
              gap: 10,
              background: active ? 'var(--surface-2)' : 'transparent'
            }}
          >
            {option.everyone ? (
              <GroupAvatar members={members} size={24} />
            ) : (
              <BotAvatar bot={option.bot} size={24} />
            )}
            <span
              className="min-w-0 flex-1 truncate"
              style={{
                fontSize: 'var(--fs-chrome)',
                lineHeight: 'var(--lh-chrome)',
                letterSpacing: 'var(--ls-chrome)',
                fontWeight: 550,
                color: 'var(--fg-primary)'
              }}
            >
              {option.everyone ? 'everyone' : option.name}
            </span>
            {option.title ? (
              <span
                className="shrink-0 truncate"
                style={{
                  maxWidth: 130,
                  fontSize: 'var(--fs-micro)',
                  lineHeight: 'var(--lh-micro)',
                  color: 'var(--fg-tertiary)'
                }}
              >
                {option.title}
              </span>
            ) : null}
          </div>
        )
      })}
    </PickerPanel>
  )
}
