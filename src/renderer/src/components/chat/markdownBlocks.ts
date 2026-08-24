/**
 * Streaming-safe markdown block splitting.
 *
 * THE PROBLEM. A bot message grows by a few characters up to 30 times a second.
 * Re-parsing and re-rendering the whole body on every delta is O(n) per token and
 * O(n²) over a turn — a 40 KB answer ends up re-rendering ~1.2 M characters of
 * markdown, and the transcript visibly stutters near the end of a long reply.
 *
 * THE FIX. Split the body into top-level blocks and return each block's exact
 * `raw` source. Because the scan is a single deterministic left-to-right pass,
 * appending characters can only ever change the LAST block: every earlier block's
 * raw string is byte-identical between renders, so a `React.memo` keyed on that
 * string hits every time and only the final block re-parses.
 *
 * THE TRAP. Two constructs silently break that guarantee:
 *
 *  1. An unclosed HTML tag. `<div>` opens a container that swallows the markdown
 *     after it. If we keep starting new blocks inside it, every boundary shifts
 *     the moment `</div>` lands and *every* downstream memo misses at once. So
 *     while the HTML tag stack is non-empty we append into the previous block
 *     instead of starting a new one.
 *  2. Unclosed block math (`$$`). Same shape, same fix.
 *
 * Nothing here adds a dependency: this is a hand-written CommonMark/GFM block
 * scanner, not a full parser. It only has to agree with remark about where a
 * block *starts*, because remark still parses each block's raw text.
 */

/* ------------------------------------------------------------------ *
 * Line classification
 * ------------------------------------------------------------------ */

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const RE_ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const RE_QUOTE = /^ {0,3}>/
const RE_BULLET = /^ {0,3}[-*+](?:[ \t]|$)/
const RE_ORDERED = /^ {0,3}(\d{1,9})[.)](?:[ \t]|$)/
const RE_HTML_START = /^ {0,3}<[a-zA-Z!/?]/
const RE_INDENT_CODE = /^(?: {4}|\t)/
const RE_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/
/** A GFM table delimiter row: `|---|:--:|`. Needs at least one dash. */
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/**
 * Can this line end the paragraph above it? Bullet lists and `1.` can interrupt
 * a paragraph in CommonMark; `2.` cannot, which is why the digit is checked.
 */
function interrupts(line: string): boolean {
  if (RE_ATX.test(line)) return true
  if (RE_FENCE_OPEN.test(line)) return true
  if (RE_HR.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  if (RE_BULLET.test(line)) return true
  if (RE_HTML_START.test(line)) return true
  const ordered = RE_ORDERED.exec(line)
  return ordered !== null && ordered[1] === '1'
}

function indentOf(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (c === ' ') n += 1
    else if (c === '\t') n += 4
    else break
  }
  return n
}

/** Split keeping the line terminators, so joining the pieces restores the source. */
function toLines(source: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      out.push(source.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < source.length) out.push(source.slice(start))
  return out
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '')
}

/* ------------------------------------------------------------------ *
 * The raw block scan
 * ------------------------------------------------------------------ */

/**
 * Split `source` into raw top-level blocks. `blocks.join('') === source` always
 * holds — that exactness is what makes the memo keys trustworthy.
 *
 * Blank lines are attached to the block that FOLLOWS them rather than the one
 * before, so a completed block's raw never changes when the writer hits Enter.
 */
function scanBlocks(source: string): string[] {
  if (source.length === 0) return []

  const raw = toLines(source)
  const text = raw.map(stripEol)
  const n = raw.length

  // Character offset of the start of each line, plus a sentinel for the end.
  const offset = new Array<number>(n + 1)
  let running = 0
  for (let i = 0; i < n; i += 1) {
    offset[i] = running
    running += raw[i]!.length
  }
  offset[n] = running

  const blocks: string[] = []
  let cursor = 0
  let i = 0

  while (i < n) {
    if (isBlank(text[i]!)) {
      i += 1
      continue
    }
    i = consumeBlock(text, i, n)
    const end = offset[i]!
    blocks.push(source.slice(cursor, end))
    cursor = end
  }

  if (cursor < source.length) {
    // Trailing blank lines. Appending them to the last block keeps the join
    // exact without creating a block that renders as nothing.
    if (blocks.length > 0) blocks[blocks.length - 1] += source.slice(cursor)
    else blocks.push(source.slice(cursor))
  }

  return blocks
}

/** Advance past the block starting at line `i`; returns the first line after it. */
function consumeBlock(text: string[], start: number, n: number): number {
  const first = text[start]!
  let i = start

  // Indented code is checked first: at a block boundary a 4-space indent is a
  // code block, not a lazy continuation of anything.
  if (RE_INDENT_CODE.test(first)) {
    i += 1
    let lastContent = i
    while (i < n && (isBlank(text[i]!) || RE_INDENT_CODE.test(text[i]!))) {
      if (!isBlank(text[i]!)) lastContent = i + 1
      i += 1
    }
    return lastContent
  }

  const fence = RE_FENCE_OPEN.exec(first)
  if (fence) {
    const marker = fence[1]![0]!
    const size = fence[1]!.length
    i += 1
    while (i < n) {
      const line = text[i]!
      i += 1
      if (isClosingFence(line, marker, size)) break
    }
    // An unterminated fence deliberately runs to the end of the source: it is
    // one block that keeps growing, which is exactly what a live stream is.
    return i
  }

  if (RE_ATX.test(first) || RE_HR.test(first)) return start + 1

  if (RE_QUOTE.test(first)) {
    i += 1
    while (i < n && !isBlank(text[i]!) && !RE_FENCE_OPEN.test(text[i]!)) i += 1
    return i
  }

  if (RE_BULLET.test(first) || RE_ORDERED.test(first)) {
    i += 1
    while (i < n) {
      if (isBlank(text[i]!)) {
        // A loose list survives blank lines, but only if the list actually
        // continues below them.
        let j = i
        while (j < n && isBlank(text[j]!)) j += 1
        if (j < n && (RE_BULLET.test(text[j]!) || RE_ORDERED.test(text[j]!) || indentOf(text[j]!) >= 2)) {
          i = j
          continue
        }
        return i
      }
      if (RE_BULLET.test(text[i]!) || RE_ORDERED.test(text[i]!) || indentOf(text[i]!) >= 1) {
        i += 1
        continue
      }
      if (interrupts(text[i]!)) return i
      i += 1 // lazy continuation of the item's paragraph
    }
    return i
  }

  if (isTableStart(text, start, n)) {
    i = start + 2
    while (i < n && !isBlank(text[i]!) && text[i]!.includes('|')) i += 1
    return i
  }

  if (RE_HTML_START.test(first)) {
    i += 1
    while (i < n && !isBlank(text[i]!)) i += 1
    return i
  }

  // Paragraph.
  i += 1
  while (i < n && !isBlank(text[i]!) && !interrupts(text[i]!)) i += 1
  // A `===` / `---` rule directly under a paragraph is a setext heading, so it
  // belongs to this block rather than starting a new one.
  if (i < n && !isBlank(text[i]!) && RE_SETEXT.test(text[i]!)) i += 1
  return i
}

function isClosingFence(line: string, marker: string, size: number): boolean {
  const trimmed = line.trimEnd()
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(trimmed)
  if (!match) return false
  return match[1]![0] === marker && match[1]!.length >= size
}

function isTableStart(text: string[], i: number, n: number): boolean {
  if (!text[i]!.includes('|')) return false
  if (i + 1 >= n) return false
  const delimiter = text[i + 1]!
  return delimiter.includes('-') && RE_TABLE_DELIM.test(delimiter)
}

/* ------------------------------------------------------------------ *
 * HTML / math state carried between blocks
 * ------------------------------------------------------------------ */

/** Elements that never have a closing tag, so they must not push the stack. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/**
 * Every HTML element name, used by the streaming repair below to tell a
 * half-typed tag (`<di`, `<a href="…`) from a bare `<` that happens to sit in
 * prose (`a<b`, `Bearer <TOKEN`). Matching is CASE-SENSITIVE on purpose: HTML
 * elements are lowercase, so `<Button onClick={fn}` reads as a JSX component in
 * a sentence rather than a tag and its text is left alone.
 */
const HTML_TAG_NAMES: readonly string[] = [
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link',
  'main', 'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source',
  'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
]

/**
 * True when `name` could still grow into a real element name — `di` → `div`,
 * `a` → `a`. A name that no element starts with is prose, not markup.
 */
function isPartialTagName(name: string): boolean {
  for (const tag of HTML_TAG_NAMES) {
    if (tag.startsWith(name)) return true
  }
  return false
}

export interface BlockScanState {
  /** Tag names opened and not yet closed. */
  readonly stack: readonly string[]
  /** True while an odd number of `$$` markers have been seen. */
  readonly math: boolean
}

const EMPTY_STATE: BlockScanState = { stack: [], math: false }

const RE_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g
const RE_FENCE_REGION = /(?:^|\n) {0,3}(`{3,}|~{3,})[\s\S]*?(?:\n {0,3}\1[ \t]*(?=\n|$)|$)/g
const RE_INLINE_CODE = /`[^`\n]*`/g

/** Advance the HTML/math state across one raw block. */
function scanState(block: string, state: BlockScanState): BlockScanState {
  // Tags and `$$` inside code are text, not markup.
  const scrubbed = block.replace(RE_FENCE_REGION, '\n').replace(RE_INLINE_CODE, '')

  let stack = state.stack
  let mutated = false

  RE_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RE_TAG.exec(scrubbed)) !== null) {
    const closing = match[1] === '/'
    const name = match[2]!.toLowerCase()
    const rest = match[3] ?? ''
    if (!closing && (rest.trimEnd().endsWith('/') || VOID_TAGS.has(name))) continue

    if (!mutated) {
      stack = stack.slice()
      mutated = true
    }
    const list = stack as string[]
    if (closing) {
      const at = list.lastIndexOf(name)
      if (at !== -1) list.splice(at, list.length - at)
    } else {
      list.push(name)
    }
  }

  let math = state.math
  let index = scrubbed.indexOf('$$')
  while (index !== -1) {
    math = !math
    index = scrubbed.indexOf('$$', index + 2)
  }

  if (!mutated && math === state.math) return state
  return { stack, math }
}

/* ------------------------------------------------------------------ *
 * Public API — split with a small incremental cache
 * ------------------------------------------------------------------ */

interface SplitCache {
  source: string
  /** `source`'s first `HEAD` characters, the cheap discriminator between entries. */
  head: string
  blocks: string[]
  /** Source offset where each merged block begins. */
  starts: number[]
  /** HTML/math state as it was *before* each merged block. */
  states: BlockScanState[]
}

/**
 * ONE ENTRY PER CONCURRENTLY-STREAMING MESSAGE, NOT ONE FOR THE WHOLE APP.
 *
 * The cache used to be a single slot, and its fast path requires the new source
 * to extend the cached one — true only while a SINGLE message grows. The app's
 * marquee feature is a group chat where up to `maxConcurrentBots` reply at once,
 * and each Bot flushes deltas ~30 times a second, so consecutive calls came from
 * different messages, every call missed, and each delta re-scanned a whole body.
 * Four entries would do for the shipped default; eight covers the 12-Bot cap
 * plus whatever else re-rendered in the same commit, and costs one string
 * comparison each.
 */
export const SPLIT_CACHE_SIZE = 8

/**
 * Enough of the head of a body to tell two messages apart in O(1). A growing
 * message keeps its first characters, so this is stable per message for as long
 * as the entry is useful.
 */
const HEAD = 32

/** Most-recently-used first; at most `SPLIT_CACHE_SIZE` long. */
const cache: SplitCache[] = []

/**
 * Split a markdown body into memo-stable top-level blocks.
 *
 * The incremental cache turns the common case — the same message growing by a
 * few characters — into a re-scan of only the final block instead of the whole
 * body. Restarting at a merged block's own start offset with the state recorded
 * there produces byte-identical output to a cold scan.
 */
export function splitMarkdownBlocks(source: string): string[] {
  if (source.length === 0) return []

  // Computed once, and it is what flattens the rope the store builds with
  // `previous + delta`: every comparison below then runs on a flat string.
  const head = source.length <= HEAD ? source : source.slice(0, HEAD)

  let base: SplitCache | null = null
  let baseAt = -1
  for (let i = 0; i < cache.length; i += 1) {
    const entry = cache[i]!
    // Length first, head second: both are O(1) and reject every entry belonging
    // to another message before anything walks a 40 KB string. `startsWith`
    // rather than equality because an entry recorded while its message was
    // shorter than HEAD has a shorter head — comparing those for equality would
    // switch the cache off for the first 32 characters of every stream.
    if (entry.source.length > source.length || !head.startsWith(entry.head)) continue
    if (entry.source.length === source.length) {
      if (entry.source !== source) continue
      touch(i)
      return entry.blocks
    }
    // NOT `startsWith`. On the ConsString shape the store produces it walks the
    // rope and cost 90µs for a 40 KB prefix — 94% of the warm path, so the
    // "incremental" cache was really O(n) per delta. Slicing to the same length
    // and comparing is the same test for 3µs.
    if (source.slice(0, entry.source.length) !== entry.source) continue
    base = entry
    baseAt = i
    break
  }

  let blocks: string[] = []
  let starts: number[] = []
  let states: BlockScanState[] = []
  let offset = 0
  let state = EMPTY_STATE

  if (base && base.blocks.length > 1) {
    // RESCAN THE LAST TWO BLOCKS, NOT THE LAST ONE.
    //
    // Appending characters usually only changes the final block, but it can also
    // UN-CREATE the boundary in front of it, and a cache that only ever revisits
    // the final block can never take a boundary back. The trigger is ordinary in
    // Claude's output: a soft-wrapped continuation line that starts with `*`. At
    // the prefix "…summary:\n*" the lone `*` matches RE_BULLET, so it interrupts
    // the paragraph and a boundary is written; one character later it is `**`,
    // which interrupts nothing — but the split was already frozen in the cache.
    // The reader then watched a reply arrive as two paragraphs (two `.md-block`
    // elements, 10px apart) that silently became one paragraph with a soft break
    // the next time the row rendered cold. `1.` after a number and `#` after a
    // word do the same thing.
    //
    // Because the stale boundary is always the LAST boundary at the moment it is
    // created, restarting one block earlier catches it on the very next append —
    // and it also covers the only cross-block lookahead in the scanner (setext
    // underlines and table delimiter rows, which read the following line). The
    // `length > 1` guard above is still exactly right: at length 2 `keep` is 0,
    // and starts[0]/states[0] are 0/EMPTY_STATE, i.e. a correct full rescan.
    // Costs nothing in memoization — the re-scanned block is value-identical, so
    // MarkdownBlockView's `prev.raw === next.raw` still hits.
    const keep = base.blocks.length - 2
    blocks = base.blocks.slice(0, keep)
    starts = base.starts.slice(0, keep)
    states = base.states.slice(0, keep)
    offset = base.starts[keep]!
    state = base.states[keep]!
  }

  let position = offset
  for (const block of scanBlocks(source.slice(offset))) {
    if ((state.stack.length > 0 || state.math) && blocks.length > 0) {
      // Inside an open <div> (or open `$$`): appending keeps every following
      // boundary anchored, which is what preserves downstream memoization.
      blocks[blocks.length - 1] += block
    } else {
      blocks.push(block)
      starts.push(position)
      states.push(state)
    }
    position += block.length
    state = scanState(block, state)
  }

  // A message that grew REPLACES its own entry: keeping the superseded prefix
  // would let one long reply fill every slot and evict the other Bots streaming
  // beside it — the exact thrash this cache exists to avoid.
  const entry: SplitCache = { source, head, blocks, starts, states }
  if (baseAt !== -1) cache[baseAt] = entry
  else if (cache.unshift(entry) > SPLIT_CACHE_SIZE) cache.length = SPLIT_CACHE_SIZE
  if (baseAt > 0) touch(baseAt)
  return blocks
}

/** Move an entry to the front so the least useful one is always the last. */
function touch(index: number): void {
  if (index === 0) return
  const [entry] = cache.splice(index, 1)
  cache.unshift(entry!)
}

/* ------------------------------------------------------------------ *
 * Fence inspection
 * ------------------------------------------------------------------ */

/**
 * True when the block ends inside a code fence that has not been closed yet.
 * The renderer uses this to show plain preformatted text instead of asking a
 * syntax highlighter to re-tokenize a half-written program on every keystroke.
 */
export function hasOpenFence(block: string): boolean {
  const lines = toLines(block).map(stripEol)
  let marker: string | null = null
  let size = 0
  for (const line of lines) {
    if (marker === null) {
      const open = RE_FENCE_OPEN.exec(line)
      if (open) {
        marker = open[1]![0]!
        size = open[1]!.length
      }
      continue
    }
    if (isClosingFence(line, marker, size)) {
      marker = null
      size = 0
    }
  }
  return marker !== null
}

/* ------------------------------------------------------------------ *
 * Repairing a half-written block
 * ------------------------------------------------------------------ */

const RE_TRAILING_IMAGE = /!\[[^\]\n]*\](?:\([^)\n]*)?$/
const RE_TRAILING_IMAGE_OPEN = /!\[[^\]\n]*$/
const RE_TRAILING_LINK = /\[([^\]\n]*)\]\([^)\n]*$/
/**
 * A half-typed HTML tag at the very end of the block.
 *
 * The two guards are the whole point, and both were bugs once: the leading
 * `(?:^|[^A-Za-z0-9_])` stops a `<` glued to a word from matching (`a<b`,
 * `Promise<Result`, `List<String`), and group 2 is checked against
 * `isPartialTagName` so a bare `<WORD` in prose is not treated as markup. The
 * earlier `/<\/?[a-zA-Z][^>\n]*$/` had neither, so `[^>\n]*$` ran to the end of
 * the block and a Bot writing "use it when a<b and you want the smaller one"
 * watched everything after the `<` vanish until a `>` or a newline arrived.
 *
 * Group 1 is the tag text alone: the leading guard consumes the character
 * BEFORE the `<`, so only group 1 may be sliced off.
 */
const RE_TRAILING_TAG = /(?:^|[^A-Za-z0-9_])(<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[\s/][^>\n]*)?)$/

/**
 * Make a still-streaming block parse the way it will once it is finished.
 *
 * Without this the transcript visibly flickers: `**foo` renders as literal
 * asterisks for one frame and as bold the next, a half-typed image shows a
 * broken-image placeholder, and `<di` shows as text before becoming a tag.
 *
 * Only ever applied to the LAST block of a message that is still streaming —
 * a finished message must render exactly what its author wrote.
 */
export function repairStreamingMarkdown(block: string): string {
  // An open fence is already handled by rendering it as plain preformatted
  // text; "repairing" the code inside it would corrupt the user's code.
  if (hasOpenFence(block)) return block

  let text = block

  // An incomplete image is removed outright rather than shown as a broken one.
  text = text.replace(RE_TRAILING_IMAGE, '').replace(RE_TRAILING_IMAGE_OPEN, '')
  // An incomplete link degrades to its own label until the href lands.
  text = text.replace(RE_TRAILING_LINK, '$1')
  // A half-typed tag would otherwise flash as literal text. Only the tag itself
  // is removed, and only when it really is one — see RE_TRAILING_TAG.
  const tag = RE_TRAILING_TAG.exec(text)
  if (tag && isPartialTagName(tag[2]!)) text = text.slice(0, text.length - tag[1]!.length)

  return repairDelimiters(text)
}

interface OpenDelimiter {
  char: string
  length: number
}

/**
 * Close unterminated `**`, `*`, `_`, `` ` `` and `~~` runs.
 *
 * Runs are matched by (character, length) pairs, which is what makes `***x***`,
 * `**x**` and `*x*` all behave. Intra-word underscores are skipped because
 * `snake_case` is not emphasis and appending a `_` to it would show a stray
 * character in the middle of a sentence.
 */
function repairDelimiters(text: string): string {
  const stack: OpenDelimiter[] = []
  let danglingAt = -1
  let danglingLength = 0

  let i = 0
  const n = text.length

  while (i < n) {
    const ch = text[i]!

    if (ch === '\\') {
      i += 2
      continue
    }

    if (ch === '`') {
      let length = 0
      while (i + length < n && text[i + length] === '`') length += 1
      const close = findBacktickRun(text, i + length, length)
      if (close === -1) {
        // Everything after an unterminated code span is code, so close it and
        // stop: emphasis markers inside a code span are literal.
        return text + '`'.repeat(length)
      }
      i = close + length
      continue
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let length = 0
      while (i + length < n && text[i + length] === ch) length += 1

      if (ch === '~' && length !== 2) {
        i += length
        continue
      }

      const before = i > 0 ? text[i - 1]! : ''
      const after = i + length < n ? text[i + length]! : ''
      const canOpen = after !== '' && !/\s/.test(after)
      const canClose = before !== '' && !/\s/.test(before)

      // `snake_case`: an underscore flanked by word characters is literal.
      if (ch === '_' && /\w/.test(before) && /\w/.test(after)) {
        i += length
        continue
      }

      const top = stack[stack.length - 1]
      if (top && top.char === ch && top.length === length && canClose) {
        stack.pop()
      } else if (canOpen) {
        stack.push({ char: ch, length })
      } else {
        danglingAt = i
        danglingLength = length
      }
      i += length
      continue
    }

    i += 1
  }

  let out = text

  // A run typed at the very end (`foo **`) cannot be classified yet. Dropping it
  // is quieter than either leaving raw asterisks or guessing at a closer.
  if (danglingAt !== -1 && danglingAt + danglingLength === out.length) {
    out = out.slice(0, danglingAt)
  }

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    out += stack[k]!.char.repeat(stack[k]!.length)
  }

  return out
}

function findBacktickRun(text: string, from: number, length: number): number {
  let i = from
  const n = text.length
  while (i < n) {
    if (text[i] === '`') {
      let run = 0
      while (i + run < n && text[i + run] === '`') run += 1
      if (run === length) return i
      i += run
      continue
    }
    i += 1
  }
  return -1
}

/* ------------------------------------------------------------------ *
 * Cheap classification used by the renderer
 * ------------------------------------------------------------------ */

const RE_MARKDOWNISH = /[*_`~[\]<>|#]|^\s{0,3}[-+]\s|^\s{0,3}\d+[.)]\s|\bhttps?:\/\//m

/**
 * True when a block is ordinary prose with nothing for the markdown parser to
 * do. Most chat messages are exactly this, and the plain-text path skips a
 * micromark parse plus a hast-to-JSX conversion on every single delta.
 */
export function isPlainProse(block: string): boolean {
  return !RE_MARKDOWNISH.test(block)
}
