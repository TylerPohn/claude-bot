/**
 * Turns raw Claude Code tool events into the activity cards the chat UI renders.
 *
 * The product rule from PRD section 16 is blunt: **never dump raw JSON into the user
 * transcript**. A card headline is a short human phrase - "src/app.ts", "npm test",
 * "useState" - and the raw payload lives behind the expand affordance in `detail`.
 *
 * This module is pure (no electron, no db, no logger) so it can be unit-tested with
 * `node --test`, and so a mis-shaped tool input can never take down a running turn.
 */
import path from 'node:path'
import { homedir } from 'node:os'
import type { Activity, ActivityType } from '@shared/types'

export interface MappedActivity {
  type: ActivityType
  /** Short one-line label, e.g. "npm test" or "src/app.ts". Never contains raw JSON. */
  title: string
  subtitle: string | null
  /** Full input rendering for the expanded view; `mapToolEnd` appends the output. */
  detail: string | null
  toolName: string
  /**
   * Line counts derived from the tool *input* at start time. Additive to the contract
   * in ARCHITECTURE section 3.5: `mapToolEnd` never sees the input again, so the
   * start-time estimate has to ride along to act as a fallback when the structured
   * result carries no patch.
   */
  addedLines?: number | null
  removedLines?: number | null
}

export interface ToolEndInput {
  isError: boolean
  content: string
  structured: unknown
}

export interface MappedActivityEnd {
  subtitle: string | null
  detail: string | null
  addedLines: number | null
  removedLines: number | null
}

const TITLE_MAX = 120
const SUBTITLE_MAX = 120
const DETAIL_MAX = 20_000

/** How many individual shell commands a transcript summary lists before collapsing. */
const MAX_LISTED_COMMANDS = 3

/* ------------------------------------------------------------------ *
 * unknown-safe helpers
 * ------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** First line with visible content, trimmed. Empty string when there is none. */
function firstLine(value: string): string {
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

function countLines(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function safeStringify(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Render a path the way a human refers to it: relative to the workspace when it is
 * inside it, `~`-shortened otherwise. Titles full of `/Users/...` prefixes are noise.
 */
export function displayPath(target: string, cwd: string): string {
  if (!target) return target
  const normalized = path.normalize(target).replace(/[/\\]+$/, '') || target

  if (cwd && path.isAbsolute(normalized)) {
    const base = path.normalize(cwd).replace(/[/\\]+$/, '')
    const relative = path.relative(base, normalized)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative
    }
  }

  const home = homedir()
  if (home && normalized.startsWith(home + path.sep)) {
    return `~${normalized.slice(home.length)}`
  }
  return normalized
}

/** `mcp__github__create_issue` -> `{ server: 'github', tool: 'create_issue' }`. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  // Server names legitimately contain single underscores (`claude_code_bots`), so the
  // split point is the FIRST double underscore, not the last.
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const server = rest.slice(0, sep)
  const tool = rest.slice(sep + 2)
  if (!server || !tool) return null
  return { server, tool }
}

function renderInput(input: JsonRecord): string | null {
  if (Object.keys(input).length === 0) return null
  return truncate(safeStringify(input), DETAIL_MAX)
}

function formatDiff(added: number | null, removed: number | null): string | null {
  const a = added ?? 0
  const r = removed ?? 0
  if (a === 0 && r === 0) return null
  return `+${a} -${r}`
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`)
}

/* ------------------------------------------------------------------ *
 * mapToolStart
 * ------------------------------------------------------------------ */

/**
 * Turn a `tool_use` name + input into an activity card header.
 *
 * Titles follow the quality bar in the module contract: the *thing* the tool acted on,
 * never the tool's own name and never its serialized arguments.
 */
export function mapToolStart(name: string, input: unknown, cwd: string): MappedActivity {
  const raw = isRecord(input) ? input : {}

  const mcp = parseMcpToolName(name)
  if (mcp) {
    return {
      type: 'mcp',
      title: truncate(`${mcp.server} / ${mcp.tool}`, TITLE_MAX),
      subtitle: null,
      detail: renderInput(raw),
      toolName: name
    }
  }

  switch (name) {
    case 'Bash': {
      const command = str(raw.command) ?? ''
      const description = str(raw.description)
      const background = raw.run_in_background === true
      return {
        type: 'command',
        title: truncate(oneLine(command), TITLE_MAX) || 'Shell command',
        subtitle: background
          ? description
            ? truncate(`${oneLine(description)} (background)`, SUBTITLE_MAX)
            : 'background'
          : description
            ? truncate(oneLine(description), SUBTITLE_MAX)
            : null,
        detail: command || renderInput(raw),
        toolName: name
      }
    }

    case 'BashOutput':
      return {
        type: 'command',
        title: 'Checked background output',
        subtitle: null,
        detail: renderInput(raw),
        toolName: name
      }

    case 'KillShell':
    case 'KillBash':
      return {
        type: 'command',
        title: 'Stopped background shell',
        subtitle: null,
        detail: renderInput(raw),
        toolName: name
      }

    case 'Read': {
      const file = str(raw.file_path) ?? str(raw.path) ?? ''
      const offset = num(raw.offset)
      const limit = num(raw.limit)
      let subtitle: string | null = null
      if (offset !== null && limit !== null) subtitle = `lines ${offset}-${offset + limit - 1}`
      else if (offset !== null) subtitle = `from line ${offset}`
      return {
        type: 'file_read',
        title: file ? truncate(displayPath(file, cwd), TITLE_MAX) : 'Read file',
        subtitle,
        detail: file || renderInput(raw),
        toolName: name
      }
    }

    case 'Write': {
      const file = str(raw.file_path) ?? ''
      const added = countLines(str(raw.content) ?? '')
      return {
        type: 'file_write',
        title: file ? truncate(displayPath(file, cwd), TITLE_MAX) : 'Wrote file',
        subtitle: formatDiff(added, 0),
        detail: file || renderInput(raw),
        toolName: name,
        addedLines: added,
        removedLines: 0
      }
    }

    case 'Edit': {
      const file = str(raw.file_path) ?? ''
      const removed = countLines(str(raw.old_string) ?? '')
      const added = countLines(str(raw.new_string) ?? '')
      return {
        type: 'file_edit',
        title: file ? truncate(displayPath(file, cwd), TITLE_MAX) : 'Edited file',
        subtitle: formatDiff(added, removed),
        detail: file || renderInput(raw),
        toolName: name,
        addedLines: added,
        removedLines: removed
      }
    }

    case 'MultiEdit': {
      const file = str(raw.file_path) ?? ''
      const edits = Array.isArray(raw.edits) ? raw.edits : []
      let added = 0
      let removed = 0
      for (const edit of edits) {
        if (!isRecord(edit)) continue
        removed += countLines(str(edit.old_string) ?? '')
        added += countLines(str(edit.new_string) ?? '')
      }
      return {
        type: 'file_edit',
        title: file ? truncate(displayPath(file, cwd), TITLE_MAX) : 'Edited file',
        subtitle: `${edits.length} ${plural(edits.length, 'edit')}`,
        detail: file || renderInput(raw),
        toolName: name,
        addedLines: added,
        removedLines: removed
      }
    }

    case 'NotebookEdit': {
      const file = str(raw.notebook_path) ?? str(raw.file_path) ?? ''
      const mode = str(raw.edit_mode)
      const cell = str(raw.cell_id)
      const parts = [mode, cell ? `cell ${cell}` : null].filter((p): p is string => p !== null)
      return {
        type: 'notebook',
        title: file ? truncate(displayPath(file, cwd), TITLE_MAX) : 'Edited notebook',
        subtitle: parts.length > 0 ? parts.join(' · ') : null,
        detail: file || renderInput(raw),
        toolName: name
      }
    }

    case 'Glob': {
      const pattern = str(raw.pattern) ?? ''
      const scope = str(raw.path)
      return {
        type: 'search',
        title: truncate(oneLine(pattern), TITLE_MAX) || 'File search',
        subtitle: scope ? `in ${displayPath(scope, cwd)}` : null,
        detail: renderInput(raw),
        toolName: name
      }
    }

    case 'Grep': {
      const pattern = str(raw.pattern) ?? ''
      const scope = str(raw.path)
      const glob = str(raw.glob)
      const where = scope ? displayPath(scope, cwd) : glob
      return {
        type: 'search',
        title: truncate(oneLine(pattern), TITLE_MAX) || 'Search',
        subtitle: where ? `in ${where}` : null,
        detail: renderInput(raw),
        toolName: name
      }
    }

    case 'WebFetch': {
      const url = str(raw.url) ?? ''
      const parsed = safeUrl(url)
      const host = parsed ? parsed.hostname.replace(/^www\./, '') : oneLine(url)
      const pathname = parsed && parsed.pathname !== '/' ? parsed.pathname : null
      return {
        type: 'web',
        title: truncate(host || 'Web request', TITLE_MAX),
        subtitle: pathname ? truncate(pathname, SUBTITLE_MAX) : null,
        detail: [url, str(raw.prompt)].filter((p): p is string => p !== null).join('\n\n') || null,
        toolName: name
      }
    }

    case 'WebSearch': {
      const query = str(raw.query) ?? ''
      return {
        type: 'web',
        title: truncate(oneLine(query), TITLE_MAX) || 'Web search',
        subtitle: null,
        detail: renderInput(raw),
        toolName: name
      }
    }

    case 'Task': {
      const description = str(raw.description) ?? ''
      const agent = str(raw.subagent_type)
      return {
        type: 'task',
        title: truncate(oneLine(description), TITLE_MAX) || 'Subagent task',
        subtitle: agent,
        detail: str(raw.prompt) ?? renderInput(raw),
        toolName: name
      }
    }

    case 'TodoWrite': {
      const todos = Array.isArray(raw.todos) ? raw.todos : []
      const done = todos.filter((t) => isRecord(t) && t.status === 'completed').length
      return {
        type: 'todo',
        title: 'Updated plan',
        subtitle: todos.length > 0 ? `${done}/${todos.length} done` : null,
        detail: renderTodos(todos) ?? renderInput(raw),
        toolName: name
      }
    }

    case 'ExitPlanMode':
      return {
        type: 'task',
        title: 'Proposed a plan',
        subtitle: null,
        detail: str(raw.plan) ?? renderInput(raw),
        toolName: name
      }

    case 'Skill': {
      const skill = str(raw.skill) ?? str(raw.command) ?? ''
      return {
        type: 'task',
        title: truncate(oneLine(skill), TITLE_MAX) || 'Ran a skill',
        subtitle: 'skill',
        detail: renderInput(raw),
        toolName: name
      }
    }

    default:
      return {
        type: 'tool',
        title: `Used ${name}`,
        subtitle: null,
        detail: renderInput(raw),
        toolName: name
      }
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function renderTodos(todos: unknown[]): string | null {
  if (todos.length === 0) return null
  const lines: string[] = []
  for (const todo of todos) {
    if (!isRecord(todo)) continue
    const status = str(todo.status) ?? 'pending'
    const text = str(todo.content) ?? str(todo.activeForm) ?? ''
    const marker = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
    lines.push(`${marker} ${text}`)
  }
  return lines.length > 0 ? truncate(lines.join('\n'), DETAIL_MAX) : null
}

/* ------------------------------------------------------------------ *
 * mapToolEnd
 * ------------------------------------------------------------------ */

/**
 * Enrich a card once its `tool_result` lands: success/error wording, `+N -M` for edits,
 * the first line of output for shell commands, and the combined input+output detail.
 */
export function mapToolEnd(started: MappedActivity, result: ToolEndInput): MappedActivityEnd {
  const detail = composeDetail(started.detail, result.content)
  const structured = result.structured

  switch (started.type) {
    case 'command': {
      const stdout = isRecord(structured) ? (str(structured.stdout) ?? '') : ''
      const stderr = isRecord(structured) ? (str(structured.stderr) ?? '') : ''
      if (result.isError) {
        const reason = firstLine(stderr) || firstLine(result.content) || firstLine(stdout)
        return {
          subtitle: reason ? `failed — ${truncate(reason, SUBTITLE_MAX)}` : 'failed',
          detail,
          addedLines: null,
          removedLines: null
        }
      }
      const line = firstLine(stdout) || firstLine(result.content)
      return {
        subtitle: line ? truncate(line, SUBTITLE_MAX) : started.subtitle,
        detail,
        addedLines: null,
        removedLines: null
      }
    }

    case 'file_edit':
    case 'file_write':
    case 'notebook': {
      if (result.isError) {
        return { ...failure(result), detail, addedLines: null, removedLines: null }
      }
      const patch = countStructuredPatch(structured)
      const added = patch ? patch.added : (started.addedLines ?? null)
      const removed = patch ? patch.removed : (started.removedLines ?? null)
      const diff = formatDiff(added, removed)
      // MultiEdit's start subtitle is the edit count, which stays useful next to the
      // line counts; every other edit tool's start subtitle *is* the estimated diff.
      const subtitle =
        started.toolName === 'MultiEdit' && started.subtitle
          ? diff
            ? `${started.subtitle} · ${diff}`
            : started.subtitle
          : (diff ?? started.subtitle)
      return { subtitle, detail, addedLines: added, removedLines: removed }
    }

    case 'file_read': {
      if (result.isError) {
        return { ...failure(result), detail, addedLines: null, removedLines: null }
      }
      const lines = readLineCount(structured, result.content)
      return {
        subtitle: lines === null ? started.subtitle : `${lines} ${plural(lines, 'line')}`,
        detail,
        addedLines: null,
        removedLines: null
      }
    }

    case 'search': {
      if (result.isError) {
        return { ...failure(result), detail, addedLines: null, removedLines: null }
      }
      const label = searchCountLabel(structured, result.content)
      const scope = started.subtitle
      const subtitle = label ? (scope ? `${label} ${scope}` : label) : scope
      return { subtitle, detail, addedLines: null, removedLines: null }
    }

    case 'todo':
      // The result is just an echo of the list we already summarized at start.
      return {
        subtitle: result.isError ? failure(result).subtitle : started.subtitle,
        detail,
        addedLines: null,
        removedLines: null
      }

    default: {
      if (result.isError) {
        return { ...failure(result), detail, addedLines: null, removedLines: null }
      }
      const line = firstLine(result.content)
      return {
        subtitle: line ? truncate(line, SUBTITLE_MAX) : started.subtitle,
        detail,
        addedLines: null,
        removedLines: null
      }
    }
  }
}

function failure(result: ToolEndInput): { subtitle: string } {
  const reason = firstLine(result.content)
  return { subtitle: reason ? `failed — ${truncate(reason, SUBTITLE_MAX)}` : 'failed' }
}

function composeDetail(inputDetail: string | null, output: string): string | null {
  const trimmedOutput = output.trim()
  if (!inputDetail && !trimmedOutput) return null
  if (!inputDetail) return truncate(output, DETAIL_MAX)
  if (!trimmedOutput) return truncate(inputDetail, DETAIL_MAX)
  return truncate(`${inputDetail}\n\n───\n${output}`, DETAIL_MAX)
}

/**
 * Claude Code returns a unified diff for Edit/Write as
 * `structuredPatch: [{ lines: ['+added', '-removed', ' context'] }]`. Counting the
 * signed lines is far more accurate than the start-time estimate from `old_string`.
 */
function countStructuredPatch(structured: unknown): { added: number; removed: number } | null {
  if (!isRecord(structured)) return null
  const patch = structured.structuredPatch
  if (!Array.isArray(patch) || patch.length === 0) return null

  let added = 0
  let removed = 0
  let sawLine = false
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue
      sawLine = true
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return sawLine ? { added, removed } : null
}

function readLineCount(structured: unknown, content: string): number | null {
  if (isRecord(structured)) {
    const file = isRecord(structured.file) ? structured.file : null
    const direct = num(structured.numLines) ?? (file ? num(file.numLines) : null)
    if (direct !== null) return direct
  }
  const trimmed = content.trim()
  return trimmed.length > 0 ? countLines(trimmed) : null
}

function searchCountLabel(structured: unknown, content: string): string | null {
  if (isRecord(structured)) {
    const numFiles = num(structured.numFiles)
    const numLines = num(structured.numLines)
    const filenames = Array.isArray(structured.filenames) ? structured.filenames.length : null

    if (structured.mode === 'content' && numLines !== null) {
      return `${numLines} ${plural(numLines, 'match', 'matches')}`
    }
    if (numFiles !== null) return `${numFiles} ${plural(numFiles, 'file')}`
    if (filenames !== null) return `${filenames} ${plural(filenames, 'file')}`
    if (numLines !== null) return `${numLines} ${plural(numLines, 'match', 'matches')}`
  }
  const trimmed = content.trim()
  if (!trimmed) return 'no matches'
  const lines = countLines(trimmed)
  return `${lines} ${plural(lines, 'result')}`
}

/* ------------------------------------------------------------------ *
 * summarizeActivities
 * ------------------------------------------------------------------ */

interface SummaryGroup {
  key: string
  seq: number
  activities: Activity[]
}

/**
 * Collapse a finished activity list into the one-line transcript summaries from
 * PRD section 16, e.g. `["Edited 3 files", "Ran `npm test` - passed", "Read 8 files"]`.
 *
 * Groups appear in the order they first occurred, so the summary reads like a
 * narrative of the turn rather than a fixed template.
 */
export function summarizeActivities(activities: Activity[]): string[] {
  const groups = new Map<string, SummaryGroup>()

  for (const activity of activities) {
    const key = groupKey(activity.type)
    if (key === null) continue
    const existing = groups.get(key)
    if (existing) existing.activities.push(activity)
    else groups.set(key, { key, seq: activity.seq, activities: [activity] })
  }

  const ordered = [...groups.values()].sort((a, b) => a.seq - b.seq)
  const lines: string[] = []
  for (const group of ordered) lines.push(...summarizeGroup(group))
  return lines
}

function groupKey(type: ActivityType): string | null {
  switch (type) {
    case 'thinking':
      return null // not a user-visible action
    case 'file_edit':
    case 'file_write':
      return 'edit'
    case 'file_read':
      return 'read'
    case 'command':
      return 'command'
    case 'search':
      return 'search'
    case 'web':
      return 'web'
    case 'task':
      return 'task'
    case 'todo':
      return 'todo'
    case 'mcp':
      return 'mcp'
    case 'notebook':
      return 'notebook'
    case 'error':
      return 'error'
    case 'tool':
      return 'tool'
    default:
      return 'tool'
  }
}

function summarizeGroup(group: SummaryGroup): string[] {
  const items = group.activities
  const count = items.length
  const distinctTitles = new Set(items.map((a) => a.title))

  switch (group.key) {
    case 'edit':
      return [
        distinctTitles.size === 1
          ? `Edited ${items[0]!.title}`
          : `Edited ${distinctTitles.size} ${plural(distinctTitles.size, 'file')}`
      ]

    case 'notebook':
      return [
        distinctTitles.size === 1
          ? `Edited ${items[0]!.title}`
          : `Edited ${distinctTitles.size} ${plural(distinctTitles.size, 'notebook')}`
      ]

    case 'read':
      return [
        distinctTitles.size === 1
          ? `Read ${items[0]!.title}`
          : `Read ${distinctTitles.size} ${plural(distinctTitles.size, 'file')}`
      ]

    case 'command': {
      const lines = items
        .slice(0, MAX_LISTED_COMMANDS)
        .map((a) => `Ran \`${a.title}\` — ${outcomeWord(a.status)}`)
      const rest = count - Math.min(count, MAX_LISTED_COMMANDS)
      if (rest > 0) lines.push(`Ran ${rest} more ${plural(rest, 'command')}`)
      return lines
    }

    case 'search':
      return [
        count === 1
          ? `Searched for ${items[0]!.title}`
          : `Ran ${count} ${plural(count, 'search', 'searches')}`
      ]

    case 'web':
      return [
        count === 1
          ? `Fetched ${items[0]!.title}`
          : `Made ${count} web ${plural(count, 'request')}`
      ]

    case 'task':
      return [
        count === 1
          ? `Ran subagent: ${items[0]!.title}`
          : `Ran ${count} subagent ${plural(count, 'task')}`
      ]

    case 'mcp':
      return [
        distinctTitles.size === 1
          ? `Called ${items[0]!.title}`
          : `Called ${count} MCP ${plural(count, 'tool')}`
      ]

    case 'todo':
      return ['Updated the plan']

    case 'error':
      return [`Hit ${count} ${plural(count, 'error')}`]

    default:
      return [
        distinctTitles.size === 1 ? items[0]!.title : `Used ${count} ${plural(count, 'tool')}`
      ]
  }
}

function outcomeWord(status: Activity['status']): string {
  switch (status) {
    case 'success':
      return 'passed'
    case 'error':
      return 'failed'
    default:
      return 'running'
  }
}
