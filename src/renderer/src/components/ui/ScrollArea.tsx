import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

/**
 * Not a library — the app's scrollbars are styled globally in `main.css`. This
 * only pairs `.scroller` (thin themed bar + `overscroll-behavior: contain`,
 * which is what stops scroll chaining and rubber-band jank) with the overflow
 * rule, so no surface can forget one of the two.
 */
export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...rest }, ref) {
    return (
      <div {...rest} ref={ref} className={cn('scroller min-h-0 overflow-y-auto', className)}>
        {children}
      </div>
    )
  }
)
