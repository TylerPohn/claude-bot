import type { LucideIcon } from 'lucide-react'
import {
  Blocks,
  BookOpen,
  Brain,
  CircleAlert,
  FilePen,
  FilePlus,
  Globe,
  Layers,
  ListTodo,
  NotebookPen,
  Search,
  Terminal,
  Wrench
} from 'lucide-react'

import type { Activity, ActivityStatus, ActivityType } from '@shared/types'

/**
 * One icon and one semantic colour per activity type.
 *
 * The colour is doing real work: scanning a finished turn, a reader should be
 * able to tell "it edited things" from "it only read things" without reading a
 * word. Reads and searches are accent-blue (safe, informational), writes are
 * green, edits are amber (the turn changed your files), commands are teal, and
 * anything that failed is the danger red.
 */

export interface ActivityVisual {
  Icon: LucideIcon
  color: string
  /** Present-tense verb used while the activity is running. */
  verb: string
  /** Plural noun used in the collapsed summary strip. */
  noun: string
  nounPlural: string
}

export const ACTIVITY_VISUAL: Record<ActivityType, ActivityVisual> = {
  thinking: {
    Icon: Brain,
    color: 'var(--fg-tertiary)',
    verb: 'Thinking',
    noun: 'thought',
    nounPlural: 'thoughts'
  },
  tool: {
    Icon: Wrench,
    color: 'var(--fg-secondary)',
    verb: 'Using',
    noun: 'tool call',
    nounPlural: 'tool calls'
  },
  command: {
    Icon: Terminal,
    color: 'var(--fg-positive)',
    verb: 'Running',
    noun: 'command',
    nounPlural: 'commands'
  },
  file_read: {
    Icon: BookOpen,
    color: 'var(--accent)',
    verb: 'Reading',
    noun: 'file',
    nounPlural: 'files'
  },
  file_write: {
    Icon: FilePlus,
    color: 'var(--fg-success)',
    verb: 'Writing',
    noun: 'file',
    nounPlural: 'files'
  },
  file_edit: {
    Icon: FilePen,
    color: 'var(--fg-warning)',
    verb: 'Editing',
    noun: 'file',
    nounPlural: 'files'
  },
  search: {
    Icon: Search,
    color: 'var(--accent)',
    verb: 'Searching',
    noun: 'search',
    nounPlural: 'searches'
  },
  web: {
    Icon: Globe,
    color: 'var(--fg-positive)',
    verb: 'Fetching',
    noun: 'page',
    nounPlural: 'pages'
  },
  task: {
    Icon: Layers,
    color: 'var(--av-violet)',
    verb: 'Delegating',
    noun: 'subtask',
    nounPlural: 'subtasks'
  },
  todo: {
    Icon: ListTodo,
    color: 'var(--fg-secondary)',
    verb: 'Updating',
    noun: 'plan update',
    nounPlural: 'plan updates'
  },
  mcp: {
    Icon: Blocks,
    color: 'var(--av-indigo)',
    verb: 'Calling',
    noun: 'MCP call',
    nounPlural: 'MCP calls'
  },
  notebook: {
    Icon: NotebookPen,
    color: 'var(--av-pink)',
    verb: 'Editing',
    noun: 'notebook',
    nounPlural: 'notebooks'
  },
  error: {
    Icon: CircleAlert,
    color: 'var(--fg-danger)',
    verb: 'Failing',
    noun: 'error',
    nounPlural: 'errors'
  }
}

const FALLBACK: ActivityVisual = ACTIVITY_VISUAL.tool

export function activityVisual(type: ActivityType): ActivityVisual {
  return ACTIVITY_VISUAL[type] ?? FALLBACK
}

/**
 * Running is accent, success takes the type's own colour, failure is always red.
 *
 * `live` is the owning MESSAGE's liveness, not the row's. A row still marked
 * `running` on a settled turn was abandoned when the turn was stopped or failed
 * — nothing ever closed it — so it must not keep wearing the "happening now"
 * accent for the rest of the transcript's life.
 */
export function activityStatusColor(
  status: ActivityStatus,
  type: ActivityType,
  live = true
): string {
  if (status === 'error') return 'var(--fg-danger)'
  if (status === 'running') return live ? 'var(--accent)' : 'var(--fg-tertiary)'
  return activityVisual(type).color
}

/**
 * A diff stat at the end of an activity subtitle — "+118 -0", "1 edit · +2 -1".
 * Both the ASCII hyphen `formatDiff` writes and the real minus the chips render.
 */
const DIFF_STAT = /\s*\+\d+\s*[-\u2212]\d+\s*$/

/**
 * The subtitle with any diff stat removed.
 *
 * `ActivityMapper` puts the line counts in BOTH `subtitle` and
 * `addedLines`/`removedLines` for Write, Edit, MultiEdit and NotebookEdit, so
 * every one of those rows printed its stat twice — once as grey text and once as
 * the coloured +/− chips ("+118 -0  +118"), in two different glyph sets. The
 * chips win: they colour-code additions against deletions and suppress a zero
 * side. Whatever else the subtitle carried survives, so MultiEdit keeps its
 * "1 edit".
 */
export function withoutDiffStat(subtitle: string | null | undefined): string | null {
  if (!subtitle) return null
  const trimmed = subtitle.replace(DIFF_STAT, '').replace(/\s*·\s*$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Tools whose `subtitle` is the diff stat rather than the target; their path is the title. */
const PATH_IN_TITLE: ReadonlySet<ActivityType> = new Set<ActivityType>([
  'file_write',
  'file_edit',
  'notebook'
])

/**
 * What this activity is acting ON — a path, a command, a query — or null.
 *
 * NOT simply `subtitle`: the mapper only puts the target there for some tools.
 * For Write/Edit/NotebookEdit the subtitle is the diff stat and the path is the
 * title, which is why the working indicator used to read "Editing +14 -5" and
 * why the summary strip counted unique FILES by their diff stat.
 */
export function activityTarget(activity: Activity): string | null {
  const subtitle = withoutDiffStat(activity.subtitle)
  if (subtitle) return subtitle
  if (PATH_IN_TITLE.has(activity.type)) {
    const title = activity.title.trim()
    return title.length > 0 ? title : null
  }
  return null
}

/** Trim a path to something that still identifies the file inside a 13px line. */
export function shortPath(value: string, segments = 2): string {
  const clean = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (clean.length === 0) return value
  const parts = clean.split('/').filter(Boolean)
  if (parts.length <= segments) return parts.join('/')
  return `…/${parts.slice(-segments).join('/')}`
}

/** One line of a command, collapsed, so a heredoc cannot blow out the row. */
function firstLine(value: string, max = 52): string {
  const line = value.split('\n')[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The live label for a running activity.
 *
 * This is deliberately built from the event's own fields — the tool's target
 * path or command — and never from a timer cycling through invented phrases.
 * "Reading src/app.ts" tells the user something; "Thinking…" on a loop does not.
 */
export function activityRunningLabel(activity: Activity): string {
  const visual = activityVisual(activity.type)
  const target = activityTarget(activity)

  if (activity.type === 'thinking') return 'Thinking'
  if (activity.type === 'todo') return 'Updating the plan'

  if (target && target.length > 0) {
    const detail =
      activity.type === 'command' || activity.type === 'search'
        ? firstLine(target)
        : shortPath(target)
    return `${visual.verb} ${detail}`
  }

  // No structured target: main's own title is the next-best real signal.
  return activity.title.trim().length > 0 ? activity.title.trim() : `${visual.verb}…`
}
