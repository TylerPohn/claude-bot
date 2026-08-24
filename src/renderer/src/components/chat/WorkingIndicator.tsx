import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { Activity } from '@shared/types'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { activityRunningLabel } from '@/components/activity/activityIcons'

/**
 * The "this Bot is working" affordance.
 *
 * Four rules from DESIGN §6, all of them load-bearing:
 *
 *  - The motion is a gradient sweeping THROUGH the label text (`.shimmer-text`),
 *    not a spinner sitting beside it, and there is exactly ONE moving element.
 *  - The label is driven by real events — "Reading src/app.ts", "Running npm
 *    test" — never a timer cycling invented phrases. Information reads as
 *    competence; motion alone reads as stalling.
 *  - After ~5 seconds it also shows elapsed time and a step count, because
 *    concrete numbers are what make a long wait feel supervised.
 *  - The row's height is reserved from the first frame, so real text replacing
 *    it never makes the transcript jump.
 *
 * The shimmer is additionally gated on viewport visibility: a conversation the
 * user has scrolled away from should not be animating a gradient every frame.
 */

/** DESIGN §6: elapsed time appears after about five seconds. */
const ELAPSED_AFTER_MS = 5000

export interface WorkingIndicatorProps {
  activities: Activity[]
  /** Turn start — the response message's own creation time. */
  startedAt: string
  /** Shown before the first tool event arrives. */
  fallback?: string
  className?: string
}

export function WorkingIndicator({
  activities,
  startedAt,
  fallback = 'Working',
  className
}: WorkingIndicatorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(startedAt).getTime())

  useEffect(() => {
    const node = hostRef.current
    if (!node || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '120px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    // One second is the right granularity: this is a duration, not a stopwatch,
    // and a faster tick would repaint the transcript for no added information.
    const update = (): void => setElapsed(Date.now() - new Date(startedAt).getTime())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [visible, startedAt])

  const label = useMemo(() => {
    for (let i = activities.length - 1; i >= 0; i -= 1) {
      const activity = activities[i]!
      if (activity.status === 'running') return activityRunningLabel(activity)
    }
    // Every tool call has finished, so the Bot is composing its answer.
    return activities.length > 0 ? 'Writing the reply' : fallback
  }, [activities, fallback])

  const steps = useMemo(
    () => activities.filter((activity) => activity.type !== 'thinking').length,
    [activities]
  )

  const showElapsed = elapsed >= ELAPSED_AFTER_MS

  return (
    <div
      ref={hostRef}
      className={cn('flex items-center gap-[8px]', className)}
      // Height is reserved from the first frame, not derived from the content.
      style={{ height: 22 }}
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(visible && 'shimmer-text')}
        style={{
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          letterSpacing: 'var(--ls-meta)',
          fontWeight: 550,
          // No inline `color` while shimmering: it would win over the
          // background-clip:text fill and kill the effect entirely.
          ...(visible ? {} : { color: 'var(--fg-tertiary)' })
        }}
      >
        {label}
      </span>

      {showElapsed ? (
        <span
          className="text-[var(--fg-quaternary)]"
          style={{
            fontSize: 'var(--fs-micro)',
            lineHeight: 'var(--lh-micro)',
            letterSpacing: 'var(--ls-micro)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {formatDuration(elapsed)}
          {steps > 0 ? ` · ${steps} ${steps === 1 ? 'step' : 'steps'}` : ''}
        </span>
      ) : null}
    </div>
  )
}
