import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'

export type PopoverAlign = 'start' | 'center' | 'end'

export interface PopoverProps {
  open: boolean
  onClose(): void
  /** The element the popover is positioned against. */
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  align?: PopoverAlign
  side?: 'top' | 'bottom'
  width?: number
  className?: string
  /** Accessible name; a menu popover should always carry one. */
  label?: string
  /** `menu` for a list of commands, `dialog` for a picker. Drives ARIA only. */
  role?: 'menu' | 'dialog'
}

/**
 * An anchored surface with click-outside and Esc. Positioned in a layout effect
 * against the anchor's viewport rect and flipped when it would overflow, so a
 * menu opened from a row near the bottom of the sidebar still fits on screen.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = 'start',
  side = 'bottom',
  width = 220,
  className,
  label,
  role = 'menu'
}: PopoverProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null)

  const place = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const gap = 6
    const height = panelRef.current?.offsetHeight ?? 0

    let top = side === 'bottom' ? rect.bottom + gap : rect.top - gap - height
    if (side === 'bottom' && top + height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - gap - height)
    }

    let left =
      align === 'start'
        ? rect.left
        : align === 'end'
          ? rect.right - width
          : rect.left + rect.width / 2 - width / 2
    left = Math.min(Math.max(12, left), window.innerWidth - width - 12)

    setStyle({ top, left })
  }, [align, anchorRef, side, width])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    place()
  }, [open, place])

  // Focus lands after placement, not on open: the panel renders
  // `visibility: hidden` until `place()` has run, and focusing a hidden element
  // is a no-op. Keyed on `style` so it fires exactly once, when it becomes real.
  useEffect(() => {
    if (!open || !style) return
    const panel = panelRef.current
    if (!panel) return
    if (panel.contains(document.activeElement)) return
    const first =
      panel.querySelector<HTMLElement>('button[aria-checked="true"]:not([disabled])') ??
      panel.querySelector<HTMLElement>('button:not([disabled])')
    first?.focus()
  }, [open, style])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const items = (): HTMLElement[] => {
      const panel = panelRef.current
      if (!panel) return []
      return [...panel.querySelectorAll<HTMLElement>('button:not([disabled])')]
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        // Esc must land the user back where they opened the menu from, not on
        // <body> forty tab stops away.
        anchorRef.current?.focus()
        return
      }

      const list = items()
      if (list.length === 0) return
      const index = list.findIndex((item) => item === document.activeElement)

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = index === -1 ? (step === 1 ? 0 : list.length - 1) : (index + step + list.length) % list.length
        list[next]?.focus()
        return
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        ;(e.key === 'Home' ? list[0] : list[list.length - 1])?.focus()
        return
      }
      if (e.key === 'Tab') {
        // An open menu owns the tab sequence: without this, Tab walks the page
        // BEHIND the menu while the menu is still on screen.
        e.preventDefault()
        e.stopPropagation()
        onClose()
        anchorRef.current?.focus()
      }
    }
    // Re-place rather than close on scroll: closing a menu because the list
    // behind it moved one pixel feels broken.
    const onReflow = (): void => place()

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [anchorRef, onClose, open, place])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={className}
      style={{
        position: 'fixed',
        top: style?.top ?? -9999,
        left: style?.left ?? -9999,
        width,
        zIndex: 'var(--z-popover)',
        background: 'var(--surface-3)',
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--r-popover)',
        boxShadow: 'var(--shadow-medium)',
        padding: 6,
        // Hidden until placed, so it never flashes at the top-left corner.
        visibility: style ? 'visible' : 'hidden',
        animation: 'slide-up-in var(--dur-fast) var(--ease-out-quad)'
      }}
    >
      {children}
    </div>,
    document.body
  )
}

/** A 32px row inside a `Popover`, matching DESIGN §3.2's `+` menu. */
export function PopoverItem({
  children,
  onSelect,
  danger = false,
  disabled = false,
  leading
}: {
  children: ReactNode
  onSelect(): void
  danger?: boolean
  disabled?: boolean
  leading?: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-[8px] rounded-[6px] px-[8px] text-left transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)] hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-40"
      style={{
        height: 32,
        fontSize: 'var(--fs-chrome)',
        color: danger ? 'var(--fg-danger)' : 'var(--fg-primary)'
      }}
    >
      {leading ? <span className="grid h-[16px] w-[16px] place-items-center">{leading}</span> : null}
      <span className="truncate">{children}</span>
    </button>
  )
}

export function PopoverDivider(): ReactElement {
  return (
    <div
      role="separator"
      style={{ height: 1, background: 'var(--border-1)', margin: '6px 8px' }}
    />
  )
}
