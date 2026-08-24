import type { ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

import type { Toast } from '@/stores/uiStore'
import { useUiStore } from '@/stores/uiStore'
import { IconButton } from './IconButton'

const ICON = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle
} as const

const COLOR: Record<Toast['level'], string> = {
  info: 'var(--fg-secondary)',
  success: 'var(--fg-success)',
  warn: 'var(--fg-warning)',
  error: 'var(--fg-danger)'
}

/**
 * Bottom-right stack. Deliberately separate from the in-transcript notification
 * tray (DESIGN §3.9): that tray is for things the user must act on inside a
 * conversation, this is for transient app-level feedback.
 */
export function Toaster(): ReactElement | null {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed right-[16px] bottom-[16px] flex w-[320px] flex-col items-stretch gap-[8px]"
      style={{ zIndex: 'var(--z-toast)' }}
    >
      {toasts.map((toast) => {
        const Icon = ICON[toast.level]
        return (
          <div
            key={toast.id}
            role={toast.level === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-[10px]"
            style={{
              padding: '10px 10px 10px 12px',
              background: 'var(--surface-3)',
              border: '1px solid var(--border-2)',
              borderRadius: 'var(--r-popover)',
              boxShadow: 'var(--shadow-high)',
              animation: 'slide-up-in var(--dur-base) var(--ease-out-quad)'
            }}
          >
            <Icon
              size={16}
              strokeWidth={1.75}
              aria-hidden
              style={{ color: COLOR[toast.level], marginTop: 2 }}
              className="shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p
                className="text-[var(--fg-primary)]"
                style={{ fontSize: 'var(--fs-chrome)', lineHeight: 'var(--lh-chrome)', fontWeight: 550 }}
              >
                {toast.title}
              </p>
              {toast.body ? (
                <p
                  className="selectable mt-[2px] text-[var(--fg-secondary)]"
                  style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
                >
                  {toast.body}
                </p>
              ) : null}
              {toast.actionLabel && toast.onAction ? (
                <button
                  type="button"
                  className="mt-[6px] text-[var(--accent)] hover:underline"
                  style={{ fontSize: 'var(--fs-meta)', fontWeight: 550 }}
                  onClick={() => {
                    toast.onAction?.()
                    dismiss(toast.id)
                  }}
                >
                  {toast.actionLabel}
                </button>
              ) : null}
            </div>
            <IconButton label="Dismiss" size={24} onClick={() => dismiss(toast.id)}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}
