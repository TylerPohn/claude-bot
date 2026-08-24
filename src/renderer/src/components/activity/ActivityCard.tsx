import { memo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Check, Copy } from 'lucide-react'

import type { Activity } from '@shared/types'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { bridge } from '@/lib/ipc'
import { Spinner } from '@/components/ui/Spinner'
import { activityStatusColor, activityVisual, shortPath, withoutDiffStat } from './activityIcons'

/**
 * The expanded view of one tool activity — DESIGN §2.4's nested-panel pattern.
 *
 *   outer card   --bubble-agent-bg,  radius 20, padding 16, label 15/550
 *   inner panel  --bubble-nested-bg, radius 14, padding 14, mono 13
 *
 * The inner panel is the reason this reads as a product rather than a log
 * viewer: raw tool output is quarantined inside its own surface instead of being
 * dumped into the transcript.
 */

/** Long output is clamped: a 4000-line test log must not own the transcript. */
const CLAMP_LINES = 18

export interface ActivityCardProps {
  activity: Activity
  /**
   * Is the MESSAGE this row belongs to still running? A `running` row on a
   * settled message was abandoned mid-flight when the turn was stopped or
   * failed, and must read as stopped rather than spin forever.
   */
  live?: boolean
}

export const ActivityCard = memo(function ActivityCard({
  activity,
  live = false
}: ActivityCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  const visual = activityVisual(activity.type)
  const color = activityStatusColor(activity.status, activity.type, live)
  const { Icon } = visual
  const running = activity.status === 'running'
  const abandoned = running && !live
  // The line counts render as the coloured chips below, so they must never also
  // be printed as text — see `withoutDiffStat`.
  const subtitle = withoutDiffStat(activity.subtitle)

  const detail = (activity.detail ?? '').replace(/\s+$/, '')
  const lines = detail.length > 0 ? detail.split('\n') : []
  const clamped = !expanded && lines.length > CLAMP_LINES
  const shown = clamped ? lines.slice(0, CLAMP_LINES).join('\n') : detail

  const duration =
    activity.endedAt !== null
      ? formatDuration(new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime())
      : ''

  const copy = (): void => {
    void bridge().system.copyText(detail.length > 0 ? detail : activity.title)
    setCopied(true)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className="hover-target"
      style={{
        background: 'var(--bubble-agent-bg)',
        borderRadius: 'var(--r-card)',
        padding: 16,
        maxWidth: 640
      }}
    >
      {/* Label row */}
      <div className="flex items-start gap-[10px]">
        <span className="mt-[2px] grid shrink-0 place-items-center" style={{ color }}>
          {running && live ? <Spinner size={15} /> : <Icon size={16} strokeWidth={1.75} />}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="selectable text-[var(--fg-primary)]"
            style={{
              fontSize: 'var(--fs-ui)',
              lineHeight: '20px',
              letterSpacing: 'var(--ls-ui)',
              fontWeight: 550,
              overflowWrap: 'anywhere'
            }}
          >
            {activity.title}
          </p>

          <div
            className="mt-[2px] flex flex-wrap items-center gap-x-[8px] text-[var(--fg-tertiary)]"
            style={{ fontSize: 'var(--fs-meta)', lineHeight: 'var(--lh-meta)' }}
          >
            {subtitle ? (
              <span className="truncate" title={subtitle}>
                {shortPath(subtitle, 3)}
              </span>
            ) : null}
            {activity.addedLines !== null && activity.addedLines > 0 ? (
              <span style={{ color: 'var(--fg-success)', fontVariantNumeric: 'tabular-nums' }}>
                +{activity.addedLines}
              </span>
            ) : null}
            {activity.removedLines !== null && activity.removedLines > 0 ? (
              <span style={{ color: 'var(--fg-danger)', fontVariantNumeric: 'tabular-nums' }}>
                −{activity.removedLines}
              </span>
            ) : null}
            {duration ? <span>{duration}</span> : null}
            {activity.status === 'error' ? (
              <span style={{ color: 'var(--fg-danger)' }}>Failed</span>
            ) : null}
            {/* The turn ended while this tool was still in flight. Saying so is
                the whole point of keeping the row: the user has been told
                actions may already have run, so hiding the one that was
                running made the transcript a false record. */}
            {abandoned ? <span>Stopped before it finished</span> : null}
          </div>
        </div>

        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy details'}
          title={copied ? 'Copied' : 'Copy details'}
          className={cn(
            'hover-actions grid shrink-0 place-items-center rounded-[var(--r-3)]',
            'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]',
            'transition-[background-color,color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]'
          )}
          style={{ width: 24, height: 24, background: 'var(--surface-2)', opacity: copied ? 1 : undefined }}
        >
          {copied ? (
            <Check size={13} strokeWidth={1.75} style={{ color: 'var(--fg-success)' }} />
          ) : (
            <Copy size={13} strokeWidth={1.75} />
          )}
        </button>
      </div>

      {detail.length > 0 ? (
        <div
          className="mt-[12px]"
          style={{
            background: 'var(--bubble-nested-bg)',
            borderRadius: 'var(--r-card-inner)',
            padding: 14
          }}
        >
          <pre
            className="scroller selectable overflow-x-auto text-[var(--fg-secondary)]"
            style={{
              margin: 0,
              // `overflow-x: auto` makes overflow-y compute to `auto` too, so
              // `.scroller`'s `overscroll-behavior: contain` turned this into a
              // wheel sink with nothing to scroll and froze the transcript under
              // the pointer. Chain vertically; keep sideways containment.
              overscrollBehaviorX: 'contain',
              overscrollBehaviorY: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-code)',
              lineHeight: 'var(--lh-code)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere'
            }}
          >
            {shown}
          </pre>
          {lines.length > CLAMP_LINES ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="mt-[8px] text-[var(--accent)] hover:underline"
              style={{ fontSize: 'var(--fs-meta)', fontWeight: 550 }}
            >
              {expanded ? 'Show less' : `Show all ${lines.length} lines`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
