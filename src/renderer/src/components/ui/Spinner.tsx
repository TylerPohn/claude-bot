import type { ReactElement } from 'react'

import { cn } from '@/lib/cn'

/**
 * A 14px ring. Use sparingly: the product's working indicator is shimmer text
 * driven by real agent phases (DESIGN §6) — a spinner says "waiting", the
 * shimmer says what is actually happening.
 */
export function Spinner({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): ReactElement {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block shrink-0 animate-spin rounded-full align-[-2px]', className)}
      style={{
        width: size,
        height: size,
        border: `1.75px solid var(--border-2)`,
        borderTopColor: 'var(--fg-secondary)'
      }}
    />
  )
}
