import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'
import { useFocusTrap } from './Modal'

/**
 * The right-hand editing panel (Bot profile, group setup). Same scrim, focus
 * trap and Esc behaviour as `Modal`; it slides in from the trailing edge instead
 * of scaling, because a 420px column that scaled would visibly detach from the
 * window edge it is anchored to.
 */
export interface SheetProps {
  open?: boolean
  onClose(): void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  width?: number
  children?: ReactNode
  className?: string
}

export function Sheet({
  open = true,
  onClose,
  title,
  description,
  footer,
  width = 420,
  children,
  className
}: SheetProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const descriptionId = useId()
  const close = useCallback(() => onClose(), [onClose])
  useFocusTrap(panelRef, open, close)

  // The slide-in is a transition rather than a keyframe animation so the global
  // prefers-reduced-motion reset in main.css neutralises it for free.
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 'var(--z-dialog)' }} role="presentation">
      <div
        aria-hidden
        onMouseDown={close}
        className="absolute inset-0"
        style={{
          background: 'var(--overlay)',
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
        className={cn('absolute top-0 right-0 flex h-full flex-col outline-none', className)}
        style={{
          width: `min(${width}px, 100vw)`,
          background: 'var(--surface-1)',
          borderLeft: '1px solid var(--border-1)',
          boxShadow: 'var(--shadow-high)',
          transform: entered ? 'translateX(0)' : `translateX(${width}px)`,
          transition: 'transform var(--dur-slow) var(--ease-out-quart)'
        }}
      >
        <header
          className="flex shrink-0 items-center gap-[12px]"
          style={{ height: 56, padding: '0 12px 0 20px' }}
        >
          <div className="min-w-0 flex-1">
            <h2
              id={labelId}
              className="truncate text-[var(--fg-primary)]"
              style={{
                fontSize: 'var(--fs-title)',
                lineHeight: 'var(--lh-title)',
                letterSpacing: 'var(--ls-title)',
                fontWeight: 550
              }}
            >
              {title}
            </h2>
          </div>
          <IconButton label="Close" onClick={close}>
            <X size={18} strokeWidth={1.75} />
          </IconButton>
        </header>

        {description ? (
          <p
            id={descriptionId}
            className="shrink-0 text-[var(--fg-secondary)]"
            style={{ padding: '0 20px 12px', fontSize: 'var(--fs-meta)' }}
          >
            {description}
          </p>
        ) : null}

        {/* Scroll-edge scrim, same treatment as Modal and the transcript. The
            sheet's footer already draws a hairline, but a hairline through the
            middle of a line of helper text still reads as a slice — the fade
            gets the text out of the way before the border. --surface-1, NOT
            --surface-3: this panel is the darker of the two dialog grounds and a
            surface-3 gradient would paint a visible grey band across it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="scroller min-h-0 flex-1 overflow-y-auto"
            style={{ padding: '4px 20px 20px' }}
          >
            {children}
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 bottom-0 left-0"
            style={{ height: 16, background: 'linear-gradient(transparent, var(--surface-1))' }}
          />
        </div>

        {footer ? (
          <footer
            className="flex shrink-0 items-center justify-end gap-[8px]"
            style={{ padding: '12px 20px', borderTop: '1px solid var(--border-1)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
