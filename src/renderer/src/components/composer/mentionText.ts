/**
 * The mention model (PRD §11 — a core product requirement).
 *
 * A mention is a STRUCTURED token, never a regex applied to the sent text. The
 * composer holds `MentionMark[]` alongside the raw string; on send those marks
 * travel to `messages.send` and the main process trusts them verbatim. That is
 * what makes a Bot rename safe: historical messages keep the display string
 * they were sent with, and the botId still resolves.
 *
 * Everything here is pure and DOM-free so the tricky index math is testable and
 * so `Composer.tsx` stays about interaction.
 *
 * Index convention: `startIndex` is the offset of the leading `@`, `endIndex`
 * is EXCLUSIVE, and `display` always includes the `@`.
 */
import type { Bot } from '@shared/types'
import type { MentionInput } from '@shared/schemas'

export const EVERYONE_KEY = 'everyone'
export const EVERYONE_DISPLAY = '@everyone'

/** A committed mention inside the composer's text. */
export interface MentionMark {
  botId: string | null
  display: string
  everyone: boolean
  startIndex: number
  endIndex: number
}

/** One row in the mention picker. */
export interface MentionOption {
  key: string
  botId: string | null
  display: string
  name: string
  title: string | null
  everyone: boolean
  bot: Bot | null
}

/** An in-progress `@…` or `/…` token: where it starts and what has been typed. */
export interface TriggerQuery {
  start: number
  /** Text between the trigger character and the caret. */
  query: string
  caret: number
}

/** How far back we will look for a trigger. Bot names are capped at 40 chars. */
const MAX_QUERY = 48

const WORD_CHAR = /[A-Za-z0-9_]/

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/**
 * A trigger only fires at a word boundary (start of input or after whitespace) —
 * DESIGN §4.2. Typing an `@` inside `user@example.com` must not open a picker.
 */
function atWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true
  const prev = text[index - 1]!
  return /\s/.test(prev)
}

export function displayForName(name: string): string {
  return `@${name.trim()}`
}

/**
 * Picker rows for one conversation. `@everyone` is appended LAST in a group so
 * the destructive, quota-hungry option is never the default highlighted row.
 */
export function buildMentionOptions(members: Bot[], isGroup: boolean): MentionOption[] {
  const options: MentionOption[] = members.map((bot) => ({
    key: bot.id,
    botId: bot.id,
    display: displayForName(bot.name),
    name: bot.name,
    title: bot.title,
    everyone: false,
    bot
  }))
  if (isGroup && members.length > 1) {
    options.push({
      key: EVERYONE_KEY,
      botId: null,
      display: EVERYONE_DISPLAY,
      name: 'everyone',
      title: `All ${members.length} Bots`,
      everyone: true,
      bot: null
    })
  }
  return options
}

/** True when `index` falls inside (or at the end of) a committed mention. */
export function markCovering(marks: MentionMark[], index: number): MentionMark | null {
  for (const mark of marks) {
    if (index > mark.startIndex && index <= mark.endIndex) return mark
  }
  return null
}

/**
 * The `@…` token the caret is currently sitting in, or null.
 *
 * The query may contain spaces — Bot names do ("Product Manager"), so a picker
 * that stopped at the first space could never complete one. The composer closes
 * the picker itself once a spaced query stops matching anything.
 */
export function findMentionTrigger(
  text: string,
  caret: number,
  marks: MentionMark[] = []
): TriggerQuery | null {
  const floor = Math.max(0, caret - MAX_QUERY)
  for (let i = caret - 1; i >= floor; i -= 1) {
    const char = text[i]!
    if (char === '\n') return null
    if (char !== '@') continue
    if (!atWordBoundary(text, i)) return null
    // Already committed: the caret is inside a chip, not typing a new mention.
    if (markCovering(marks, i + 1)) return null
    const query = text.slice(i + 1, caret)
    if (query.includes('@')) return null
    return { start: i, query, caret }
  }
  return null
}

/**
 * The `/command` token, which fires ONLY when it is the entire contents of the
 * composer. A slash mid-sentence is just a slash.
 */
export function findSlashTrigger(text: string, caret: number): TriggerQuery | null {
  if (!text.startsWith('/')) return null
  if (caret < 1) return null
  if (!/^\/[A-Za-z-]*$/.test(text)) return null
  return { start: 0, query: text.slice(1, caret), caret }
}

/**
 * Prefix filter, in two ranks: names that start with the query come before
 * names whose later WORD starts with it, so typing `man` still finds
 * "Product Manager" without burying an exact "Manager".
 */
export function filterMentionOptions(
  options: MentionOption[],
  query: string
): MentionOption[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return options

  const leading: MentionOption[] = []
  const inner: MentionOption[] = []
  for (const option of options) {
    const name = option.name.toLowerCase()
    if (name.startsWith(q)) {
      leading.push(option)
      continue
    }
    if (name.split(/\s+/).some((word) => word.startsWith(q))) inner.push(option)
  }
  // `@everyone` keeps its position at the end of whichever rank it lands in.
  return [...leading, ...inner]
}

/** Locate `display` at or after `from`, honouring word boundaries on both sides. */
function findDisplayAt(text: string, display: string, from: number): number {
  let index = text.indexOf(display, from)
  while (index !== -1) {
    const after = text[index + display.length]
    if (atWordBoundary(text, index) && !isWordChar(after)) return index
    index = text.indexOf(display, index + 1)
  }
  return -1
}

/**
 * Re-locate every mark after an arbitrary edit.
 *
 * Marks are walked in order against a monotonically advancing cursor, so typing
 * before a mention shifts it, and typing INSIDE one destroys the display string
 * and drops the mark entirely — which is the required "deleting any part of a
 * mention removes the whole mention" behaviour. Two mentions of the same Bot
 * stay distinct because the cursor never re-matches an earlier occurrence.
 */
export function syncMentions(text: string, marks: MentionMark[]): MentionMark[] {
  if (marks.length === 0) return marks
  const ordered = [...marks].sort((a, b) => a.startIndex - b.startIndex)
  const out: MentionMark[] = []
  let cursor = 0
  let changed = false

  for (const mark of ordered) {
    let index = -1
    // Fast path: the mark did not move (an edit after it, or no edit at all).
    if (
      mark.startIndex >= cursor &&
      text.startsWith(mark.display, mark.startIndex) &&
      atWordBoundary(text, mark.startIndex) &&
      !isWordChar(text[mark.endIndex])
    ) {
      index = mark.startIndex
    } else {
      index = findDisplayAt(text, mark.display, cursor)
    }
    if (index === -1) {
      changed = true
      continue
    }
    if (index !== mark.startIndex) changed = true
    out.push({ ...mark, startIndex: index, endIndex: index + mark.display.length })
    cursor = index + mark.display.length
  }

  // Identity matters: the composer re-renders the highlight layer on change.
  return changed || out.length !== marks.length ? out : marks
}

/**
 * Rebuild marks from raw text — used ONLY when a persisted draft comes back and
 * its structured marks are gone (a restart). Longest display first so
 * "@Product Manager" wins over a Bot that happens to be called "Product".
 */
export function deriveMentions(text: string, options: MentionOption[]): MentionMark[] {
  if (text.length === 0 || options.length === 0) return []
  const byLength = [...options].sort((a, b) => b.display.length - a.display.length)
  const out: MentionMark[] = []

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@' || !atWordBoundary(text, i)) continue
    for (const option of byLength) {
      if (!text.startsWith(option.display, i)) continue
      if (isWordChar(text[i + option.display.length])) continue
      out.push({
        botId: option.botId,
        display: option.display,
        everyone: option.everyone,
        startIndex: i,
        endIndex: i + option.display.length
      })
      i += option.display.length - 1
      break
    }
  }
  return out
}

/**
 * Committed marks plus anything the user typed by hand that resolves to a real
 * member, with overlaps resolved in favour of the committed mark.
 *
 * Main re-parses a message whose mention list is empty (`resolveMentions`), so a
 * hand-typed "@Builder" routes to Builder whether or not it came from the
 * picker. Deriving the same set here is what keeps the chips, the routing
 * selector and the actual delivery telling the user the same story.
 */
export function effectiveMentions(
  text: string,
  committed: MentionMark[],
  options: MentionOption[]
): MentionMark[] {
  const derived = deriveMentions(text, options)
  if (derived.length === 0) return committed
  if (committed.length === 0) return derived
  const merged = [...committed]
  for (const candidate of derived) {
    const overlaps = committed.some(
      (mark) => candidate.startIndex < mark.endIndex && mark.startIndex < candidate.endIndex
    )
    if (!overlaps) merged.push(candidate)
  }
  merged.sort((a, b) => a.startIndex - b.startIndex)
  return merged
}

export interface MentionEdit {
  text: string
  marks: MentionMark[]
  /** Text that replaces `[trigger.start, trigger.caret)`. */
  inserted: string
  caret: number
}

/** Replace the in-progress `@…` token with a committed mention plus a space. */
export function insertMention(
  text: string,
  marks: MentionMark[],
  trigger: TriggerQuery,
  option: MentionOption
): MentionEdit {
  const before = text.slice(0, trigger.start)
  const after = text.slice(trigger.caret)
  // One trailing space so the user can keep typing, but never a double space.
  const inserted = after.startsWith(' ') ? option.display : `${option.display} `
  const nextText = before + inserted + after
  const end = trigger.start + option.display.length
  const delta = trigger.start + inserted.length - trigger.caret

  const next: MentionMark[] = []
  for (const mark of marks) {
    if (mark.endIndex <= trigger.start) {
      next.push(mark)
    } else if (mark.startIndex >= trigger.caret) {
      next.push({ ...mark, startIndex: mark.startIndex + delta, endIndex: mark.endIndex + delta })
    }
    // Anything overlapping the trigger is being typed over and disappears.
  }
  next.push({
    botId: option.botId,
    display: option.display,
    everyone: option.everyone,
    startIndex: trigger.start,
    endIndex: end
  })
  next.sort((a, b) => a.startIndex - b.startIndex)

  return { text: nextText, marks: next, inserted, caret: trigger.start + inserted.length }
}

/**
 * The range Backspace/Delete should remove so a chip behaves atomically
 * (DESIGN §3.6). Returns null when the keystroke has nothing to do with a chip
 * and the browser's own editing should run.
 */
export function mentionDeleteRange(
  marks: MentionMark[],
  selectionStart: number,
  selectionEnd: number,
  direction: 'backward' | 'forward'
): { start: number; end: number } | null {
  if (selectionStart !== selectionEnd) return null
  const caret = selectionStart
  for (const mark of marks) {
    const inside = caret > mark.startIndex && caret < mark.endIndex
    const trailingEdge = direction === 'backward' && caret === mark.endIndex
    const leadingEdge = direction === 'forward' && caret === mark.startIndex
    if (inside || trailingEdge || leadingEdge) {
      return { start: mark.startIndex, end: mark.endIndex }
    }
  }
  return null
}

export type HighlightSegment =
  | { kind: 'text'; text: string; start: number }
  | { kind: 'mention'; text: string; start: number; mark: MentionMark }

/** Split the raw string into plain runs and chip runs for the mirror layer. */
export function splitForHighlight(text: string, marks: MentionMark[]): HighlightSegment[] {
  if (marks.length === 0) {
    return text.length > 0 ? [{ kind: 'text', text, start: 0 }] : []
  }
  const ordered = [...marks].sort((a, b) => a.startIndex - b.startIndex)
  const out: HighlightSegment[] = []
  let cursor = 0
  for (const mark of ordered) {
    if (mark.startIndex < cursor) continue
    if (mark.startIndex > cursor) {
      out.push({ kind: 'text', text: text.slice(cursor, mark.startIndex), start: cursor })
    }
    out.push({
      kind: 'mention',
      text: text.slice(mark.startIndex, mark.endIndex),
      start: mark.startIndex,
      mark
    })
    cursor = mark.endIndex
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor), start: cursor })
  return out
}

/**
 * Trim for sending while keeping the marks aligned. Trimming the string without
 * shifting the indices is the classic way to corrupt every mention in a message
 * that starts with a space.
 */
export function trimForSend(
  text: string,
  marks: MentionMark[]
): { body: string; mentions: MentionMark[] } {
  const leading = text.length - text.trimStart().length
  const body = text.trim()
  if (body.length === 0) return { body, mentions: [] }
  const mentions: MentionMark[] = []
  for (const mark of marks) {
    const startIndex = mark.startIndex - leading
    const endIndex = mark.endIndex - leading
    if (startIndex < 0 || endIndex > body.length) continue
    if (!body.startsWith(mark.display, startIndex)) continue
    mentions.push({ ...mark, startIndex, endIndex })
  }
  return { body, mentions }
}

export function toMentionInputs(marks: MentionMark[]): MentionInput[] {
  return marks.map((mark) => ({
    botId: mark.botId,
    display: mark.display,
    everyone: mark.everyone,
    startIndex: mark.startIndex,
    endIndex: mark.endIndex
  }))
}

export function hasEveryone(marks: MentionMark[]): boolean {
  return marks.some((mark) => mark.everyone)
}

/* ------------------------------------------------------------------ *
 * Per-conversation mark cache
 *
 * `uiStore` persists a draft's text, attachments and reply target, but its
 * `Draft` shape has no room for structured mentions. Rather than change a store
 * another lane owns, marks live here for the session: switching conversations
 * and coming back restores the chips exactly, and a cold start falls back to
 * `deriveMentions` over the persisted text.
 * ------------------------------------------------------------------ */

const markCache = new Map<string, MentionMark[]>()

export function rememberMentions(conversationId: string, marks: MentionMark[]): void {
  if (marks.length === 0) markCache.delete(conversationId)
  else markCache.set(conversationId, marks)
}

export function recallMentions(conversationId: string): MentionMark[] | undefined {
  return markCache.get(conversationId)
}

export function forgetMentions(conversationId: string): void {
  markCache.delete(conversationId)
}
