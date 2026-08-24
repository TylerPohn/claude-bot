import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import { cn } from '@/lib/cn'

/**
 * A placeholder block.
 *
 * `delay` (250ms by default) exists because a skeleton that flashes for 40ms on
 * a fast load is worse than no skeleton at all — it reads as a glitch. `index`
 * staggers the sweep down a list by 90ms a row so the group reads as a wave
 * rather than one blinking block (DESIGN §6).
 */
export function Skeleton({
  width,
  height = 12,
  radius = 'var(--r-4)',
  delay = 250,
  index = 0,
  className,
  style
}: {
  width?: number | string
  height?: number | string
  radius?: string
  delay?: number
  index?: number
  className?: string
  style?: CSSProperties
}): ReactElement | null {
  const [visible, setVisible] = useState(delay === 0)

  useEffect(() => {
    if (delay === 0) return
    const timer = window.setTimeout(() => setVisible(true), delay)
    return () => window.clearTimeout(timer)
  }, [delay])

  if (!visible) return null

  return (
    <span
      aria-hidden
      className={cn('skeleton block', className)}
      style={{
        width: width ?? '100%',
        height,
        borderRadius: radius,
        animationDelay: `${index * 90}ms`,
        ...style
      }}
    />
  )
}
