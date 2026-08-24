/**
 * Mention parsing and rendering.
 *
 * Two hard product constraints shape this file (PRD §11.5):
 *
 * 1. Bot names may contain spaces ("Product Manager"), so `@` mentions cannot be
 *    matched with a naive `\w+` regex. At every `@` we match the LONGEST member
 *    name that follows, case-insensitively, so "@Product Manager" never degrades
 *    into a mention of a bot called "Product".
 * 2. Renaming a Bot must not break old messages. Mentions are therefore stored
 *    structurally (`botId` + the display string captured at send time) and
 *    `segmentMentions` renders from that STORED display string. It never
 *    re-parses the body against the current roster, because the roster may have
 *    changed since the message was written.
 *
 * This module is pure: no I/O, no db, no electron. It is unit tested directly.
 */
import type { Bot, MessageMention } from '@shared/types'

/** Aliases that fan a message out to every member of the conversation. */
export const EVERYONE_ALIASES = ['everyone', 'all'] as const

/** Segment produced by {@link segmentMentions}, consumed by the renderer. */
export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; botId: string | null; everyone: boolean }

interface Candidate {
  /** Lower-cased name, compared against a lower-cased slice of the message. */
  key: string
  /**
   * The name EXACTLY as the roster spells it. Spans are measured with this, never
   * with `key`: `String.prototype.toLowerCase` is not length-preserving ('\u0130'
   * lowercases to two code units), so a key length is not a text length.
   */
  name: string
  /** Canonical display string stored on the message, e.g. "@Product Manager". */
  display: string
  botId: string | null
  everyone: boolean
}

/**
 * A `@` only opens a mention at a word boundary. Without this, the "@" in
 * "sam@example.com" would start a mention scan and could match a bot named
 * "example" mid-word.
 */
const WORD_BEFORE = /[\p{L}\p{N}_@]/u

/**
 * The character after a match must not be alphanumeric, otherwise "@Bot" would
 * match inside "@Bots" and the trailing "s" would be orphaned. Punctuation is a
 * valid terminator, which is what keeps "@Builder." from swallowing the period
 * into the name.
 */
const WORD_AFTER = /[\p{L}\p{N}_]/u

function buildCandidates(members: Bot[]): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  // The broadcast aliases go in FIRST, which reserves them against a same-named
  // member below. This used to be the other way round, and a Bot named "everyone"
  // (or "all" — both pass `botDraftSchema`, and the backup importer does not check
  // names at all) then swallowed the alias: "@everyone ship it" parsed as an
  // ordinary single-Bot mention, so `MentionRouter` never set `everyone`, the
  // "Run N Bots?" confirmation never appeared, and exactly one Bot received a
  // message the user believed they had broadcast to the whole team. The aliases are
  // reserved tokens in this grammar, so they win; the Bot holding that name still
  // receives the broadcast as a member of it.
  for (const alias of EVERYONE_ALIASES) {
    seen.add(alias)
    candidates.push({ key: alias, name: alias, display: `@${alias}`, botId: null, everyone: true })
  }

  for (const member of members) {
    const name = member.name.trim()
    if (name.length === 0) continue
    const key = name.toLowerCase()
    // First candidate wins on a duplicate key: the aliases above, then membership
    // order among the members themselves.
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ key, name, display: `@${name}`, botId: member.id, everyone: false })
  }

  // Longest first so the greedy scan below picks "Product Manager" over "Product".
  // Measured on `name`, because that is how many characters a match consumes in
  // the original text. A tie can only be reached by two DIFFERENT names of equal
  // length, and `matchAt` compares the text against each key, so tie order cannot
  // change which one matches.
  return candidates.sort((a, b) => b.name.length - a.name.length)
}

/**
 * Match a candidate at `from` in the ORIGINAL text.
 *
 * This used to scan a `text.toLowerCase()` copy with offsets taken from `text`.
 * That is only safe while lowercasing preserves length, and it does not: 'İ'
 * (U+0130, ordinary Turkish) lowercases to two code units, so a single one of
 * them earlier in the message shifted every later index by one. "İİ @Atlas ping"
 * found no mention at all and the message silently misrouted. Lowercase one
 * candidate-sized SLICE instead, so every index stays in original-text units.
 */
function matchAt(text: string, from: number, candidates: Candidate[]): Candidate | null {
  for (const candidate of candidates) {
    const end = from + candidate.name.length
    if (text.slice(from, end).toLowerCase() !== candidate.key) continue
    const after = text[end]
    if (after !== undefined && WORD_AFTER.test(after)) continue
    return candidate
  }
  return null
}

/**
 * Parse composer text into structured mentions against the member roster.
 *
 * `startIndex`/`endIndex` cover the whole `@Name` span (end exclusive) so the
 * renderer can turn exactly that slice into a chip. Because we only ever match a
 * roster name verbatim (case-insensitively), the span length always equals the
 * stored `display` length — substituting one for the other is safe.
 */
export function parseMentions(text: string, members: Bot[]): MessageMention[] {
  if (text.length === 0) return []
  const candidates = buildCandidates(members)
  if (candidates.length === 0) return []

  const mentions: MessageMention[] = []
  let cursor = 0

  while (cursor < text.length) {
    const at = text.indexOf('@', cursor)
    if (at === -1) break

    const before = at > 0 ? text[at - 1] : undefined
    if (before !== undefined && WORD_BEFORE.test(before)) {
      cursor = at + 1
      continue
    }

    const match = matchAt(text, at + 1, candidates)
    if (!match) {
      cursor = at + 1
      continue
    }

    const endIndex = at + 1 + match.name.length
    mentions.push({
      botId: match.botId,
      display: match.display,
      everyone: match.everyone,
      startIndex: at,
      endIndex
    })
    cursor = endIndex
  }

  return mentions
}

/**
 * Split a stored body into text/mention segments for rendering.
 *
 * Deliberately tolerant: a message written before a bot was renamed (or before a
 * member was removed) still carries its original spans, and a body that was
 * edited elsewhere could leave those spans stale. Anything out of range or
 * overlapping is dropped rather than throwing, so an old message always renders.
 */
export function segmentMentions(text: string, mentions: MessageMention[]): MentionSegment[] {
  if (mentions.length === 0) {
    return text.length > 0 ? [{ type: 'text', text }] : []
  }

  const ordered = [...mentions]
    .filter(
      (m) =>
        Number.isInteger(m.startIndex) &&
        Number.isInteger(m.endIndex) &&
        m.startIndex >= 0 &&
        m.endIndex > m.startIndex &&
        m.startIndex < text.length
    )
    .sort((a, b) => a.startIndex - b.startIndex)

  const segments: MentionSegment[] = []
  let cursor = 0

  for (const mention of ordered) {
    if (mention.startIndex < cursor) continue // overlaps a mention we already emitted
    if (mention.startIndex > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, mention.startIndex) })
    }
    segments.push({
      type: 'mention',
      text: mention.display,
      botId: mention.botId,
      everyone: mention.everyone
    })
    cursor = Math.min(mention.endIndex, text.length)
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) })
  }

  return segments
}
