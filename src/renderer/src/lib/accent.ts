/**
 * Bot accent colours.
 *
 * `ACCENT_HEX` in `components/ui/BotAvatar.tsx` maps an accent to a CSS custom
 * property (`var(--av-violet)`) which is all an SVG fill needs. Anything that
 * needs to *compute* with the colour — a translucent mention-chip background, a
 * ring that has to sit over an arbitrary surface — needs the literal channels,
 * because `color-mix()` on a custom property is not available in every place we
 * paint. These literals mirror `tokens.css`; change both together.
 */
import type { Bot, BotAccent } from '@shared/types'
import { BOT_ACCENTS } from '@shared/types'

export const ACCENT_RGB: Record<BotAccent, [number, number, number]> = {
  violet: [139, 92, 246],
  blue: [46, 144, 250],
  cyan: [6, 182, 212],
  emerald: [34, 197, 94],
  amber: [245, 158, 11],
  orange: [249, 115, 22],
  rose: [245, 37, 76],
  pink: [236, 72, 153],
  lime: [132, 204, 22],
  indigo: [99, 102, 241]
}

/** Human labels for the avatar picker's colour row. */
export const ACCENT_LABEL: Record<BotAccent, string> = {
  violet: 'Violet',
  blue: 'Blue',
  cyan: 'Cyan',
  emerald: 'Emerald',
  amber: 'Amber',
  orange: 'Orange',
  rose: 'Rose',
  pink: 'Pink',
  lime: 'Lime',
  indigo: 'Indigo'
}

export function isAccent(value: string): value is BotAccent {
  return (BOT_ACCENTS as readonly string[]).includes(value)
}

/** The CSS variable reference — correct for fills, borders and text colour. */
export function accentVar(accent: BotAccent | null | undefined): string {
  return `var(--av-${accent && isAccent(accent) ? accent : 'violet'})`
}

/** A translucent wash of the accent, for mention chips and selected swatches. */
export function accentAlpha(accent: BotAccent | null | undefined, alpha: number): string {
  const key = accent && isAccent(accent) ? accent : 'violet'
  const [r, g, b] = ACCENT_RGB[key]
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function accentOf(bot: Pick<Bot, 'accent'> | null | undefined): BotAccent {
  return bot && isAccent(bot.accent) ? bot.accent : 'violet'
}

/**
 * Deterministic accent from a name, so a Bot created without an explicit colour
 * still lands somewhere stable instead of always being violet. FNV-1a keeps the
 * distribution flat across short names.
 */
export function accentForName(name: string): BotAccent {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return BOT_ACCENTS[hash % BOT_ACCENTS.length]!
}

/**
 * Pick the accent least used by the existing roster, falling back to the
 * name hash. A ten-Bot sidebar where two rows share a colour is measurably
 * harder to scan.
 */
export function nextFreeAccent(taken: Iterable<BotAccent>, name = ''): BotAccent {
  const counts = new Map<BotAccent, number>()
  for (const accent of BOT_ACCENTS) counts.set(accent, 0)
  for (const accent of taken) {
    if (isAccent(accent)) counts.set(accent, (counts.get(accent) ?? 0) + 1)
  }
  let best: BotAccent = accentForName(name)
  let bestCount = counts.get(best) ?? 0
  if (bestCount === 0) return best
  for (const accent of BOT_ACCENTS) {
    const count = counts.get(accent) ?? 0
    if (count < bestCount) {
      best = accent
      bestCount = count
    }
  }
  return best
}
