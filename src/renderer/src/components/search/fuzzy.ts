/**
 * Fuzzy subsequence matching for the command palette, plus the two small text
 * helpers the palettes need to render a match.
 *
 * No dependency: a palette matcher is ~120 lines of scoring policy, and the
 * policy is the whole product decision. Off-the-shelf matchers all encode
 * someone else's idea of what should rank first.
 *
 * Scoring model (fzf-style, computed exactly rather than greedily):
 *   - every matched character earns a flat MATCH,
 *   - a character that continues the previous match earns CONSECUTIVE on top,
 *   - a character at a word boundary (string start, after a separator, a
 *     camelCase hump, the start of a digit run) earns a boundary bonus, DOUBLED
 *     for the first query character,
 *   - a run of skipped characters costs GAP_START once, then GAP_EXTEND each,
 * so "nb" scores far higher against "New Bot" (two word starts, one long gap)
 * than against "Inbox Manager" (two interior letters, no gap), which is the
 * ranking a user typing an acronym expects. Affine gaps rather than a flat
 * per-character penalty are what make that come out right: a linear penalty
 * makes every acronym lose to any accidental adjacent pair.
 *
 * The best alignment is found with a two-row dynamic program rather than a
 * greedy scan, because greedy matching gets "abc" against "a-b-abc" wrong: it
 * commits to the first `a` and never discovers the consecutive run.
 */

/** Longer targets are truncated: nothing past this can win a palette ranking. */
const MAX_TARGET = 160
const MAX_QUERY = 32

const MATCH = 16
const CONSECUTIVE = 12
/** Opening a gap is expensive; extending one already open is nearly free. */
const GAP_START = 3
const GAP_EXTEND = 1
const BONUS_START = 22
const BONUS_BOUNDARY = 14
const BONUS_CAMEL = 10
const BONUS_CASE = 2
/** The first query character is the strongest signal of intent. */
const FIRST_CHAR_MULTIPLIER = 2
/** A whole-string prefix hit ("set" -> "Settings") should always beat a scatter. */
const BONUS_PREFIX = 34
const BONUS_SUBSTRING = 18
/** Matching late in a long string is worth slightly less than matching early. */
const LEADING_PENALTY = 1
const LEADING_PENALTY_MAX = 12
/** Breaks ties toward the shorter, more specific target. */
const LENGTH_PENALTY = 0.15

/** Characters that make the FOLLOWING character a word start. */
const SEPARATOR = /[\s\-_/\\.:;,'"()[\]{}@#+*|~!?<>=&%$]/

/* Reused across every call: a palette re-ranks a few hundred targets per
   keystroke, and three array allocations per target is real garbage pressure. */
const rowA = new Float64Array(MAX_TARGET)
const rowB = new Float64Array(MAX_TARGET)
const bonuses = new Float64Array(MAX_TARGET)

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase()
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

/** Word-boundary weight of `target[index]`. */
function boundaryBonus(target: string, index: number): number {
  if (index === 0) return BONUS_START
  const previous = target[index - 1]!
  if (SEPARATOR.test(previous)) return BONUS_BOUNDARY
  const current = target[index]!
  // camelCase hump, and the digit that starts a run inside a word ("v2").
  if (isLower(previous) && isUpper(current)) return BONUS_CAMEL
  if (!isDigit(previous) && isDigit(current)) return BONUS_CAMEL
  return 0
}

/**
 * Score `query` against `target`. Higher is better; `-Infinity` means the query
 * is not a subsequence of the target at all. Case-insensitive, with a small
 * bonus for matching the author's own casing.
 */
export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0
  if (target.length === 0) return -Infinity

  const q = query.length > MAX_QUERY ? query.slice(0, MAX_QUERY) : query
  const t = target.length > MAX_TARGET ? target.slice(0, MAX_TARGET) : target
  if (q.length > t.length) return -Infinity

  const ql = q.toLowerCase()
  const tl = t.toLowerCase()

  // Cheap rejection first. Most targets fail here, and this loop is O(n) with no
  // allocation, so the dynamic program below only ever runs on real candidates.
  let probe = 0
  for (let i = 0; i < tl.length && probe < ql.length; i += 1) {
    if (tl[i] === ql[probe]) probe += 1
  }
  if (probe < ql.length) return -Infinity

  const n = t.length
  for (let j = 0; j < n; j += 1) bonuses[j] = boundaryBonus(t, j)

  // Row 0: the first query character can land anywhere, but the further in it
  // lands the weaker the match.
  let previous = rowA
  let current = rowB
  for (let j = 0; j < n; j += 1) {
    previous[j] =
      tl[j] === ql[0]
        ? MATCH +
          bonuses[j]! * FIRST_CHAR_MULTIPLIER +
          (t[j] === q[0] ? BONUS_CASE : 0) -
          Math.min(j * LEADING_PENALTY, LEADING_PENALTY_MAX)
        : -Infinity
  }

  for (let i = 1; i < ql.length; i += 1) {
    /* `carry` is the best score of any alignment of q[0..i-1] that ended at
       least TWO characters back, already discounted for the gap it will have to
       cross. Keeping it as a running maximum is what makes the affine-gap model
       O(n) per row instead of O(n^2):
         carry(j+1) = max(carry(j) - GAP_EXTEND, prev[j-1] - GAP_START). */
    let carry = -Infinity
    for (let j = 0; j < n; j += 1) {
      let value = -Infinity
      if (tl[j] === ql[i]) {
        const adjacent = j > 0 ? previous[j - 1]! : -Infinity
        // Landing right after the previous match is the only way to earn CONSECUTIVE.
        const best = Math.max(adjacent === -Infinity ? -Infinity : adjacent + CONSECUTIVE, carry)
        if (best !== -Infinity) {
          value = best + MATCH + bonuses[j]! + (t[j] === q[i] ? BONUS_CASE : 0)
        }
      }
      current[j] = value
      const closing = j > 0 ? previous[j - 1]! - GAP_START : -Infinity
      carry = Math.max(carry === -Infinity ? -Infinity : carry - GAP_EXTEND, closing)
    }
    const swap = previous
    previous = current
    current = swap
  }

  let best = -Infinity
  for (let j = 0; j < n; j += 1) {
    if (previous[j]! > best) best = previous[j]!
  }
  if (best === -Infinity) return -Infinity

  if (tl.startsWith(ql)) best += BONUS_PREFIX
  else if (tl.includes(ql)) best += BONUS_SUBSTRING

  return best - t.length * LENGTH_PENALTY
}

/**
 * What kind of text a field is, which decides how loose a match may be.
 *
 * `name` is something the user is RECALLING — a Bot's name, a command's title.
 * `prose` is free text nobody typed at the palette: a conversation's last
 * message, a Bot's description, a synonym list.
 */
export type MatchKind = 'name' | 'prose'

/**
 * The relevance floor: is this a match the user would RECOGNISE as an answer?
 *
 * `fuzzyScore` refuses only when the query is not a subsequence of the target at
 * all, and a 90-character message preview contains the letters of almost any
 * short word in order. With every finite score kept, "note" returned every
 * conversation and every Bot in the app as "10 results" — not one of which
 * contained the word — and the "No matches" state was unreachable for real
 * words.
 *
 * A score threshold cannot separate those: when the query is junk the BEST score
 * is junk too, and the runner-up is often 97% of it. Contiguity can. The two
 * shapes people actually type are
 *   - a substring — "sett" in "Settings", "sea" in "re[sea]rcher", and
 *   - an initialism, where every matched run starts a word — "nb" -> "New Bot",
 *     "expconv" -> "Export conversation".
 *
 * The initialism reading is offered to a `name` only. Typing initials is how
 * people reach for a name they remember; the first letters of four consecutive
 * words of a SENTENCE are a coincidence, and allowing them there let "note" back
 * in through "[N]o. Every handler … [o]ne wrapper, [t]he preload … [e]xposes".
 */
export function isRelevantMatch(query: string, target: string, kind: MatchKind): boolean {
  const q = query.toLowerCase()
  if (q.length === 0) return true
  // Same window the scorer uses, so the two can never disagree about a target.
  const t = target.length > MAX_TARGET ? target.slice(0, MAX_TARGET) : target
  const tl = t.toLowerCase()
  if (tl.includes(q)) return true
  return kind === 'name' && matchesWordStarts(q, t, tl)
}

/**
 * Can `q` be cut into chunks that are each a prefix of a word of `t`, in order
 * and without overlapping? Word starts are exactly the boundaries the scorer
 * pays a bonus for, so the floor and the ranking share one idea of a word.
 *
 * Longest chunk first: "sea" should be read as [sea]rch rather than as
 * [s]tart [e]xport [a]ll, and trying the long reading first also ends the search
 * immediately in the common case.
 */
function matchesWordStarts(q: string, t: string, tl: string): boolean {
  const starts: number[] = []
  for (let i = 0; i < t.length; i += 1) {
    if (boundaryBonus(t, i) > 0) starts.push(i)
  }
  if (starts.length === 0) return false

  /* Failed (queryIndex, wordIndex) pairs. Both indices only ever increase, so a
     state re-entered while it is still being explored is genuinely a dead end,
     and a successful state unwinds the whole search before it can be revisited. */
  const failed = new Set<number>()

  const attempt = (qi: number, wi: number): boolean => {
    if (qi >= q.length) return true
    if (wi >= starts.length) return false
    const key = qi * starts.length + wi
    if (failed.has(key)) return false
    failed.add(key)

    const start = starts[wi]!
    let longest = 0
    while (
      start + longest < tl.length &&
      qi + longest < q.length &&
      tl[start + longest] === q[qi + longest]
    ) {
      longest += 1
    }

    for (let len = longest; len >= 1; len -= 1) {
      // The next chunk starts at the first word start the run did not swallow.
      let next = wi + 1
      while (next < starts.length && starts[next]! < start + len) next += 1
      if (attempt(qi + len, next)) return true
    }
    return attempt(qi, wi + 1)
  }

  return attempt(0, 0)
}

/**
 * Indices of `target` to highlight for `query`, or `[]` when it does not match.
 *
 * Deliberately a cheap two-pass greedy rather than a backtrace through the
 * dynamic program: a forward scan finds the earliest position at which the query
 * is complete, then matching *backwards* from there pulls every character as far
 * right as it can go, which collapses the highlight into the tightest run
 * available. Only the handful of rows actually on screen ever call this.
 */
export function fuzzyPositions(query: string, target: string): number[] {
  if (query.length === 0 || target.length === 0) return []
  const ql = query.toLowerCase()
  const tl = target.toLowerCase()

  let consumed = 0
  let end = -1
  for (let i = 0; i < tl.length; i += 1) {
    if (tl[i] === ql[consumed]) {
      consumed += 1
      if (consumed === ql.length) {
        end = i
        break
      }
    }
  }
  if (end === -1) return []

  const positions = new Array<number>(ql.length)
  let cursor = ql.length - 1
  for (let i = end; i >= 0 && cursor >= 0; i -= 1) {
    if (tl[i] === ql[cursor]) {
      positions[cursor] = i
      cursor -= 1
    }
  }
  return cursor < 0 ? positions : []
}

export interface FuzzyResult {
  score: number
  positions: number[]
}

/** `fuzzyScore` + `fuzzyPositions`, or null when there is no match. */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const score = fuzzyScore(query, target)
  if (score === -Infinity) return null
  return { score, positions: fuzzyPositions(query, target) }
}

export interface TextPart {
  text: string
  match: boolean
}

/** Merge matched indices into runs so the renderer emits one span per run. */
export function highlightParts(text: string, positions: number[]): TextPart[] {
  if (positions.length === 0) return [{ text, match: false }]

  const parts: TextPart[] = []
  let cursor = 0
  let i = 0
  while (i < positions.length) {
    const start = positions[i]!
    let end = start
    while (i + 1 < positions.length && positions[i + 1] === end + 1) {
      i += 1
      end += 1
    }
    if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false })
    parts.push({ text: text.slice(start, end + 1), match: true })
    cursor = end + 1
    i += 1
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}

/**
 * SQLite's `snippet()` wraps each hit in U+0001 / U+0002 instead of markup, so
 * the renderer can build real elements from it. Splitting on the sentinels --
 * never `dangerouslySetInnerHTML` -- is what keeps a message body containing
 * `<script>` inert in the search results.
 */
export const MATCH_START = '\u0001'
export const MATCH_END = '\u0002'

export function splitMatchSentinels(snippet: string): TextPart[] {
  const parts: TextPart[] = []
  let buffer = ''
  let inside = false

  const flush = (): void => {
    if (buffer.length > 0) parts.push({ text: buffer, match: inside })
    buffer = ''
  }

  for (const ch of snippet) {
    if (ch === MATCH_START) {
      flush()
      inside = true
    } else if (ch === MATCH_END) {
      flush()
      inside = false
    } else {
      buffer += ch
    }
  }
  flush()
  // An unbalanced or empty snippet still has to render something.
  return parts.length > 0 ? parts : [{ text: snippet, match: false }]
}
