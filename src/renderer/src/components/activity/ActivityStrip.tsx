import { memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'

import type { Activity, ActivityType } from '@shared/types'
import { cn } from '@/lib/cn'
import { ActivityCard } from './ActivityCard'
import { activityTarget, activityVisual } from './activityIcons'

/**
 * The default, concise view of everything a Bot did during one turn.
 *
 * PRD §16: the transcript shows one compact line — "Edited 3 files · Ran npm
 * test — passed · Read 8 files" — and expands to the full cards on click. Raw
 * JSON never reaches the transcript. The summary is built from the real
 * activity records, so the counts are facts, not decoration.
 */

interface Bucket {
  key: string
  label: string
  type: ActivityType
  count: number
  danger?: boolean
}

/** One line of a command, collapsed, so a heredoc cannot blow out the row. */
function commandLabel(activity: Activity): string {
  // `title` is the command itself ("npm test"); `subtitle` is its OUTPUT
  // ("153 passing"). PRD §16 wants "Ran `npm test` — passed", so the title wins.
  const source = activity.title.trim() || activity.subtitle?.trim() || ''
  const line = source.split('\n')[0]!.trim()
  return line.length > 42 ? `${line.slice(0, 41)}…` : line
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The file a row touched.
 *
 * NOT `subtitle`: for Write and Edit the mapper puts the DIFF STAT there, so
 * counting unique subtitles counted unique diff stats — two edits of "+1 -1" to
 * two different files summarised as "Edited 1 file". `activityTarget` returns
 * the path for those tools and null for a subtitle that is not one.
 */
function pathOf(activity: Activity): string {
  return activityTarget(activity) ?? activity.title
}

function summarize(activities: Activity[]): Bucket[] {
  const edits = activities.filter((a) => a.type === 'file_edit')
  const writes = activities.filter((a) => a.type === 'file_write')
  const reads = activities.filter((a) => a.type === 'file_read')
  const commands = activities.filter((a) => a.type === 'command')
  const searches = activities.filter((a) => a.type === 'search')
  const web = activities.filter((a) => a.type === 'web')
  const tasks = activities.filter((a) => a.type === 'task')
  const mcp = activities.filter((a) => a.type === 'mcp')
  const notebooks = activities.filter((a) => a.type === 'notebook')
  const failures = activities.filter((a) => a.status === 'error')

  const buckets: Bucket[] = []

  // Files the turn CHANGED lead the summary: that is what the reader most needs
  // to know before deciding whether to look closer.
  const changed = edits.length + writes.length
  if (changed > 0) {
    const uniquePaths = new Set([...edits, ...writes].map(pathOf).filter(Boolean))
    const count = uniquePaths.size || changed
    buckets.push({
      key: 'changed',
      label: edits.length === 0 ? `Wrote ${plural(count, 'file', 'files')}` : `Edited ${plural(count, 'file', 'files')}`,
      type: edits.length === 0 ? 'file_write' : 'file_edit',
      count
    })
  }

  if (commands.length === 1) {
    const only = commands[0]!
    // A command still 'running' has reached this list only because the turn is
    // over (see `ActivityStrip`), i.e. it never reported back — say so rather
    // than printing a bare "Ran npm test".
    const outcome =
      only.status === 'error' ? ' — failed' : only.status === 'success' ? ' — passed' : ' — stopped'
    buckets.push({
      key: 'commands',
      label: `Ran ${commandLabel(only)}${outcome}`,
      type: 'command',
      count: 1,
      danger: only.status === 'error'
    })
  } else if (commands.length > 1) {
    buckets.push({
      key: 'commands',
      label: `Ran ${plural(commands.length, 'command', 'commands')}`,
      type: 'command',
      count: commands.length
    })
  }

  if (reads.length > 0) {
    const uniquePaths = new Set(reads.map(pathOf).filter(Boolean))
    const count = uniquePaths.size || reads.length
    buckets.push({
      key: 'reads',
      label: `Read ${plural(count, 'file', 'files')}`,
      type: 'file_read',
      count
    })
  }

  if (searches.length > 0) {
    buckets.push({
      key: 'searches',
      label: `Searched ${plural(searches.length, 'time', 'times')}`,
      type: 'search',
      count: searches.length
    })
  }

  if (web.length > 0) {
    buckets.push({
      key: 'web',
      label: `Fetched ${plural(web.length, 'page', 'pages')}`,
      type: 'web',
      count: web.length
    })
  }

  if (tasks.length > 0) {
    buckets.push({
      key: 'tasks',
      label: `Delegated ${plural(tasks.length, 'subtask', 'subtasks')}`,
      type: 'task',
      count: tasks.length
    })
  }

  if (mcp.length > 0) {
    buckets.push({
      key: 'mcp',
      label: plural(mcp.length, 'MCP call', 'MCP calls'),
      type: 'mcp',
      count: mcp.length
    })
  }

  if (notebooks.length > 0) {
    buckets.push({
      key: 'notebooks',
      label: `Edited ${plural(notebooks.length, 'notebook', 'notebooks')}`,
      type: 'notebook',
      count: notebooks.length
    })
  }

  const otherFailures = failures.filter((a) => a.type !== 'command')
  if (otherFailures.length > 0) {
    buckets.push({
      key: 'failed',
      label: `${otherFailures.length} failed`,
      type: 'error',
      count: otherFailures.length,
      danger: true
    })
  }

  return buckets
}

export interface ActivityStripProps {
  activities: Activity[]
  /** Is the owning message still running? */
  live: boolean
  className?: string
}

export const ActivityStrip = memo(function ActivityStrip({
  activities,
  live,
  className
}: ActivityStripProps): ReactElement | null {
  const [open, setOpen] = useState(false)

  // Thinking is surfaced separately (and only when the user asks for it); it is
  // not something the summary line should count as work.
  const visible = useMemo(
    () => activities.filter((activity) => activity.type !== 'thinking'),
    [activities]
  )
  // WHILE THE TURN IS LIVE a still-running step belongs to the working
  // indicator, which is already naming it; counting it here would duplicate it
  // and claim in the past tense that something finished when it has not.
  //
  // ONCE THE TURN IS OVER the opposite is true. A row left at 'running' is a
  // tool that was in flight when the user pressed Stop (or when the turn
  // failed) and that nothing ever closed, and the old unconditional filter hid
  // it forever — a turn whose only tool call was still open rendered no strip
  // at all, so the transcript said "Stopped. This doesn't undo actions already
  // completed." while hiding the single action that had actually run. Those
  // rows are shown, marked as stopped.
  const settled = useMemo(
    () => (live ? visible.filter((activity) => activity.status !== 'running') : visible),
    [visible, live]
  )
  const buckets = useMemo(() => summarize(settled), [settled])

  if (settled.length === 0 || buckets.length === 0) return null

  const lead = activityVisual(buckets[0]!.type)
  const LeadIcon = lead.Icon

  return (
    <div className={cn('flex flex-col', className)} style={{ gap: open ? 8 : 0 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'group flex max-w-full items-center gap-[6px] self-start rounded-[var(--r-3)]',
          'text-left transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]',
          'hover:bg-[var(--surface-hover)]'
        )}
        style={{ minHeight: 28, padding: '0 6px 0 4px' }}
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-[var(--fg-quaternary)]"
          style={{
            transform: open ? 'rotate(90deg)' : undefined,
            transition: 'transform var(--dur-fast) var(--ease-out-quad)'
          }}
        />
        <LeadIcon size={14} strokeWidth={1.75} className="shrink-0" style={{ color: lead.color }} />
        <span
          className="min-w-0 truncate text-[var(--fg-secondary)] group-hover:text-[var(--fg-primary)]"
          style={{
            fontSize: 'var(--fs-meta)',
            lineHeight: 'var(--lh-meta)',
            letterSpacing: 'var(--ls-meta)'
          }}
        >
          {buckets.map((bucket, index) => (
            <span key={bucket.key} style={bucket.danger ? { color: 'var(--fg-danger)' } : undefined}>
              {index > 0 ? <span className="text-[var(--fg-quaternary)]"> · </span> : null}
              {bucket.label}
            </span>
          ))}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col" style={{ gap: 8 }}>
          {visible.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} live={live} />
          ))}
        </div>
      ) : null}
    </div>
  )
})
