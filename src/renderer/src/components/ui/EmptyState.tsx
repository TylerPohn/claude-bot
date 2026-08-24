import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * Empty states are written, not decorated: a title that names the situation and
 * a body that names the next move. The icon is deliberately quiet
 * (`--fg-quaternary`) so the words carry the meaning.
 */
export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
  compact = false
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn('flex flex-col items-center text-center', className)}
      style={{ padding: compact ? '20px 16px' : '40px 24px', gap: compact ? 8 : 10 }}
    >
      {icon ? (
        <span className="mb-[2px] grid place-items-center text-[var(--fg-quaternary)]">{icon}</span>
      ) : null}
      <p
        className="text-[var(--fg-primary)]"
        style={{
          fontSize: compact ? 'var(--fs-chrome)' : 'var(--fs-ui)',
          lineHeight: 'var(--lh-ui)',
          letterSpacing: 'var(--ls-ui)',
          fontWeight: 550
        }}
      >
        {title}
      </p>
      {body ? (
        <p
          className="text-[var(--fg-secondary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)',
            maxWidth: 320
          }}
        >
          {body}
        </p>
      ) : null}
      {action ? <div className="mt-[6px]">{action}</div> : null}
    </div>
  )
}
