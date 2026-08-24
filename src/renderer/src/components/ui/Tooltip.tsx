import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  label: ReactNode
  children: ReactElement
  side?: TooltipSide
  /** DESIGN: 500ms. Long enough that moving across a toolbar shows nothing. */
  delay?: number
  disabled?: boolean
}

interface Position {
  top: number
  left: number
}

/**
 * A hover/focus tooltip rendered into a portal so it can escape any
 * `overflow: hidden` ancestor. Keyboard focus opens it immediately — a user
 * tabbing through a toolbar should not have to wait out a hover delay.
 */
export function Tooltip({
  label,
  children,
  side = 'top',
  delay = 500,
  disabled = false
}: TooltipProps): ReactElement {
  const [position, setPosition] = useState<Position | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const id = useId()

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const place = useCallback(() => {
    const node = anchorRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const gap = 8
    const next: Position =
      side === 'top'
        ? { top: rect.top - gap, left: rect.left + rect.width / 2 }
        : side === 'bottom'
          ? { top: rect.bottom + gap, left: rect.left + rect.width / 2 }
          : side === 'left'
            ? { top: rect.top + rect.height / 2, left: rect.left - gap }
            : { top: rect.top + rect.height / 2, left: rect.right + gap }
    setPosition(next)
  }, [side])

  const open = useCallback(
    (immediate: boolean) => {
      if (disabled) return
      clearTimer()
      if (immediate) {
        place()
        return
      }
      timerRef.current = window.setTimeout(place, delay)
    },
    [clearTimer, delay, disabled, place]
  )

  const close = useCallback(() => {
    clearTimer()
    setPosition(null)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  const translate =
    side === 'top'
      ? 'translate(-50%, -100%)'
      : side === 'bottom'
        ? 'translate(-50%, 0)'
        : side === 'left'
          ? 'translate(-100%, -50%)'
          : 'translate(0, -50%)'

  return (
    <>
      <span
        ref={(node) => {
          anchorRef.current = node
        }}
        className="contents"
        onMouseEnter={() => open(false)}
        onMouseLeave={close}
        onFocus={() => open(true)}
        onBlur={close}
        onPointerDown={close}
        aria-describedby={position ? id : undefined}
      >
        {children}
      </span>
      {position
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className="pointer-events-none fixed"
              style={{
                top: position.top,
                left: position.left,
                transform: translate,
                zIndex: 'var(--z-tooltip)',
                background: 'var(--surface-3)',
                color: 'var(--fg-primary)',
                border: '1px solid var(--border-1)',
                borderRadius: 'var(--r-3)',
                boxShadow: 'var(--shadow-medium)',
                padding: '4px 8px',
                fontSize: 'var(--fs-meta)',
                lineHeight: 'var(--lh-meta)',
                letterSpacing: 'var(--ls-meta)',
                maxWidth: 260,
                whiteSpace: 'pre-line',
                animation: 'slide-up-in var(--dur-fast) var(--ease-out-quad)'
              }}
            >
              {label}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
