/**
 * Every string the UI formats lives here so the transcript, the sidebar and the
 * details drawer can never disagree about what "yesterday" means.
 *
 * The date formats are verbatim from DESIGN §2.4 — `Today 7:58 AM`,
 * `Yesterday 4:12 PM`, `Tuesday 9:03 AM`, `Mar 4 9:03 AM`. They are built from
 * `Intl` parts rather than hand-rolled so 24-hour locales still read correctly.
 */

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

function isValid(d: Date): boolean {
  return !Number.isNaN(d.getTime())
}

/** Calendar-day difference, ignoring time of day and DST length changes. */
function dayDiff(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((db - da) / 86_400_000)
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const monthDayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthDayYearFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

/** `8:41 AM` */
export function formatTime(value: string | number | Date): string {
  const d = toDate(value)
  if (!isValid(d)) return ''
  return timeFmt.format(d)
}

/**
 * Sidebar-row timestamp. Today shows the clock, yesterday says so, the last week
 * uses the weekday name, and anything older collapses to a date.
 */
export function formatRelativeShort(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return ''
  const d = toDate(value)
  if (!isValid(d)) return ''

  const now = new Date()
  const diff = dayDiff(d, now)

  if (diff <= 0) return timeFmt.format(d)
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return weekdayFmt.format(d)
  if (d.getFullYear() === now.getFullYear()) return monthDayFmt.format(d)
  return monthDayYearFmt.format(d)
}

/** Transcript day separator. Verbatim: `Today 7:58 AM`, `Mar 4 9:03 AM`. */
export function formatDaySeparator(value: string | number | Date): string {
  const d = toDate(value)
  if (!isValid(d)) return ''

  const now = new Date()
  const diff = dayDiff(d, now)
  const time = timeFmt.format(d)

  if (diff <= 0) return `Today ${time}`
  if (diff === 1) return `Yesterday ${time}`
  if (diff < 7) return `${weekdayFmt.format(d)} ${time}`
  if (d.getFullYear() === now.getFullYear()) return `${monthDayFmt.format(d)} ${time}`
  return `${monthDayYearFmt.format(d)} ${time}`
}

/** `0 B` · `512 B` · `1.4 KB` · `23.9 MB`. Binary units, one decimal under 10. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit]}`
}

/**
 * `840ms` · `4.2s` · `1m 12s` · `1h 04m`.
 *
 * A sub-millisecond span returns '' rather than `0ms`. Every caller guards on
 * truthiness to decide whether to show a duration at all, and `0ms` sailed
 * through that guard: a tool call whose start and end timestamps land in the same
 * millisecond (ISO timestamps carry no finer resolution) put a literal "0ms" on
 * the end of every activity row. Under one millisecond we know nothing about how
 * long the thing took, so we say nothing rather than asserting zero.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`

  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    return totalSeconds < 10 ? `${totalSeconds.toFixed(1)}s` : `${Math.round(totalSeconds)}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes - hours * 60).padStart(2, '0')}m`
}

/**
 * Claude Code reports per-turn cost in USD. Sub-cent runs are the common case,
 * so they get four decimals rather than rounding to a meaningless `$0.00`.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return ''
  if (usd === 0) return '$0.00'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g
const HTML_RE = /<\/?[a-zA-Z][^>]*>/g
const HEADING_RE = /^\s{0,3}#{1,6}\s+/gm
const QUOTE_RE = /^\s{0,3}>\s?/gm
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm
const RULE_RE = /^\s{0,3}(?:[-*_]\s*){3,}$/gm
const MARKER_RE = /(\*\*\*|\*\*|~~|__|[*_`])/g

/**
 * Collapse markdown to one line of plain text for sidebar previews, OS
 * notifications and search rows. Code fences become a short label rather than
 * being dumped verbatim — a preview full of `const x =` tells the user nothing.
 */
export function plainTextPreview(markdown: string | null | undefined, max = 120): string {
  if (!markdown) return ''

  let text = markdown
    .replace(FENCE_RE, ' code ')
    .replace(IMAGE_RE, ' ')
    .replace(LINK_RE, '$1')
    .replace(HTML_RE, ' ')
    .replace(RULE_RE, ' ')
    .replace(HEADING_RE, '')
    .replace(QUOTE_RE, '')
    .replace(LIST_RE, '')
    .replace(MARKER_RE, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length <= max) return text
  // Prefer a word boundary, but never chop more than a quarter of the budget.
  text = text.slice(0, max)
  const space = text.lastIndexOf(' ')
  if (space > max * 0.75) text = text.slice(0, space)
  return `${text.trimEnd()}…`
}

/* --- FTS snippet -------------------------------------------------------- *
 *
 * SQLite's `snippet()` returns a window cut out of the raw `body_markdown`, with
 * each hit wrapped in U+0001 / U+0002 (see components/search/fuzzy.ts). Two
 * consequences drive every rule below:
 *
 *   - The sentinels must survive. None of these patterns can match U+0001 or
 *     U+0002, and none of them reorders text, so the pairs stay balanced and
 *     `splitMatchSentinels()` still finds every hit.
 *   - The window is cut mid-document, so a construct can be half-present. That
 *     is why `plainTextPreview` is NOT reused here: its `FENCE_RE` ends at
 *     ```` ``` ```` OR at end-of-string, and against a snippet that opens a fence
 *     it deletes everything after it — hits included, leaving a stub row.
 *
 * So this strip only ever deletes delimiter characters, never the content they
 * wrap, and never matches to the end of the string.
 *
 * Raw HTML is deliberately NOT stripped, unlike in `plainTextPreview`: a snippet
 * carries no clue whether its `<T>` came from prose or from a code span, and
 * `List<String>` in a hit matters more than an `<em>` nobody writes.
 */
const SNIPPET_HIT_RE = /[\u0001\u0002]/
/** `[label](url)`, and `![alt](url)` — the leading `!` goes with the brackets. */
const SNIPPET_LINK_RE = /!?\[([^\]\n]*)\]\(([^)\n]*)\)/g
/** A fence's backtick run plus its info string (```` ```ts ````), never its body. */
const SNIPPET_FENCE_RE = /`{3,}[A-Za-z0-9_+#-]*/g
const SNIPPET_MARKER_RE = /\*+|~~|`+/g
const SNIPPET_UNDERSCORE_RE = /_+/g

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch)
}

/**
 * One search result row: the FTS snippet with its markdown syntax removed and
 * its hit sentinels intact. Search was the one surface in the app that printed
 * literal `**` and backticks at the user.
 */
export function plainTextSnippet(snippet: string | null | undefined): string {
  if (!snippet) return ''

  return (
    snippet
      // A hit can land inside the URL of a link. Dropping the target would then
      // delete the very match the row exists to show, so in that case keep the
      // target text and remove only the punctuation around it.
      .replace(SNIPPET_LINK_RE, (_match, label: string, url: string) =>
        SNIPPET_HIT_RE.test(url) ? `${label} ${url}` : label
      )
      .replace(SNIPPET_FENCE_RE, '')
      .replace(RULE_RE, ' ')
      .replace(HEADING_RE, '')
      .replace(QUOTE_RE, '')
      .replace(LIST_RE, '')
      .replace(SNIPPET_MARKER_RE, '')
      // `_` is a delimiter only at a word boundary (CommonMark), and search hits
      // are full of identifiers: eating it unconditionally renamed
      // `body_markdown` to `bodymarkdown` inside the highlight itself.
      .replace(SNIPPET_UNDERSCORE_RE, (run: string, index: number, whole: string) =>
        isWordChar(whole[index - 1]) && isWordChar(whole[index + run.length]) ? run : ''
      )
  )
}

/** `3 Bots` / `1 Bot` — the group subtitle in the header pill and sidebar rows. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`
}
