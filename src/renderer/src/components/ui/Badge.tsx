import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/cn'

export type BadgeTone = 'neutral' | 'accent' | 'attention' | 'success' | 'warning' | 'danger'

const TONE: Record<BadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--chip-bg)', fg: 'var(--fg-secondary)' },
  accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  attention: { bg: 'rgba(255, 100, 10, 0.14)', fg: 'var(--attention)' },
  success: { bg: 'rgba(140, 227, 143, 0.12)', fg: 'var(--fg-success)' },
  warning: { bg: 'rgba(253, 215, 63, 0.12)', fg: 'var(--fg-warning)' },
  danger: { bg: 'rgba(242, 120, 126, 0.12)', fg: 'var(--fg-danger)' }
}

/** 18px pill, 11px / weight 590 — the unread counter and inline status labels. */
export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}): ReactElement {
  const { bg, fg } = TONE[tone]
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{
        height: 18,
        minWidth: 18,
        padding: '0 6px',
        borderRadius: 'var(--r-full)',
        background: bg,
        color: fg,
        fontSize: 11,
        lineHeight: '18px',
        fontWeight: 590,
        letterSpacing: 'var(--ls-nano)',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {children}
    </span>
  )
}
