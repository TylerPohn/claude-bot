import { useCallback, useEffect, useId, useRef } from 'react'
import type { ReactElement, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus containment for any overlay.
 *
 * Focus moves into the dialog on open, cycles inside it on Tab, and is restored
 * to whatever had it before — a dialog that dumps focus back on `<body>` leaves
 * a keyboard user stranded at the top of the document.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void
): void {
  const restoreTo = useRef<HTMLElement | null>(null)
  const armed = useRef(false)

  // WHAT HAD FOCUS is captured during RENDER, not in the effect below.
  //
  // The effect is passive: it runs after React has committed the children, and
  // React applies a child's `autoFocus` during the COMMIT (`commitHostMount`),
  // before any parent effect. Both command palettes autofocus their input, so
  // the effect used to capture the palette's own input as "what had focus
  // before". Restoring focus to a node that is being unmounted is a no-op, so
  // closing ⌘K / ⌘F dropped focus on <body> and the next Tab restarted at the
  // top of the app, ~40 stops from where the user was. A useLayoutEffect would
  // not help either — the child's commit runs before the parent's layout effect.
  // Render happens before every one of those, so this sees the real element.
  if (active && !armed.current) {
    armed.current = true
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  } else if (!active && armed.current) {
    // Re-arm for the next open. `restoreTo` is deliberately left alone: the
    // effect's cleanup has not run yet and still needs it.
    armed.current = false
  }

  useEffect(() => {
    if (!active) return

    const node = ref.current
    if (node) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node
      // rAF: the node has to be laid out before it can take focus.
      requestAnimationFrame(() => first.focus({ preventScroll: true }))
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault()
        e.stopPropagation()
        onEscape()
        return
      }
      if (e.key !== 'Tab') return
      const container = ref.current
      if (!container) return
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const target = restoreTo.current
      // `isConnected`: an overlay opened from a row that the overlay itself
      // removed (delete, unpin) leaves a detached node here, and focusing one
      // silently does nothing — which is the same stranded-on-<body> outcome.
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [active, onEscape, ref])
}

export interface ModalProps {
  open?: boolean
  onClose(): void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  /** Dialog width in px. DESIGN uses 400 / 480 / 880 depending on the surface. */
  width?: number
  height?: number
  children?: ReactNode
  className?: string
  /** Hide the built-in close button when the header is custom. */
  hideClose?: boolean
  /** Set false for a flow the user must finish (onboarding). */
  dismissOnScrim?: boolean
}

export function Modal({
  open = true,
  onClose,
  title,
  description,
  footer,
  width = 480,
  height,
  children,
  className,
  hideClose = false,
  dismissOnScrim = true
}: ModalProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const descriptionId = useId()

  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, open, close)

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ zIndex: 'var(--z-dialog)' }}
      role="presentation"
    >
      <div
        aria-hidden
        onMouseDown={dismissOnScrim ? close : undefined}
        className="absolute inset-0"
        style={{
          background: 'var(--overlay)',
          zIndex: 'var(--z-dialog-scrim)',
          animation: 'scrim-in var(--dur-base) var(--ease-out-quad)'
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn('relative flex flex-col overflow-hidden outline-none', className)}
        style={{
          width: `min(${width}px, calc(100vw - 32px))`,
          height: height ? `min(${height}px, calc(100vh - 64px))` : undefined,
          maxHeight: 'calc(100vh - 64px)',
          background: 'var(--surface-3)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--r-popover)',
          boxShadow: 'var(--shadow-dialog)',
          zIndex: 'var(--z-dialog)',
          animation: 'dialog-in var(--dur-base) var(--ease-out-quad)'
        }}
      >
        {title || !hideClose ? (
          <header
            className="flex shrink-0 items-start gap-[12px]"
            style={{ padding: '20px 20px 0 20px' }}
          >
            <div className="min-w-0 flex-1">
              {title ? (
                <h2
                  id={labelId}
                  className="text-[var(--fg-primary)]"
                  style={{
                    fontSize: 'var(--fs-title)',
                    lineHeight: 'var(--lh-title)',
                    letterSpacing: 'var(--ls-title)',
                    fontWeight: 550
                  }}
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p
                  id={descriptionId}
                  className="mt-[4px] text-[var(--fg-secondary)]"
                  style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
                >
                  {description}
                </p>
              ) : null}
            </div>
            {hideClose ? null : (
              <IconButton label="Close" onClick={close} className="-mt-[4px] -mr-[6px]">
                <X size={18} strokeWidth={1.75} />
              </IconButton>
            )}
          </header>
        ) : null}

        {/* The scroller and its scrim share a positioned box. The transcript and
            the composer both fade their scroll edges (DESIGN §3.8); the dialogs
            used to hard-cut, so a scrolled pane ended in a text line sliced
            through its x-height at the dialog's rounded corner. The gradient
            sits over the scroller's own 16px bottom padding, so it is invisible
            once the pane is scrolled to the end. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="scroller min-h-0 flex-1 overflow-y-auto" style={{ padding: '16px 20px' }}>
            {children}
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 bottom-0 left-0"
            style={{ height: 16, background: 'linear-gradient(transparent, var(--surface-3))' }}
          />
        </div>

        {footer ? (
          <footer
            className="flex shrink-0 items-center justify-end gap-[8px]"
            style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border-1)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
