/**
 * Optional safety net applied on top of the user's own `--disallowedTools`
 * (settings.safetyGuardrails, default on).
 *
 * This is NOT a sandbox and must not be presented as one. Claude Code already has
 * its own permission system; these patterns only block a handful of shell shapes
 * that are catastrophic and essentially never intended from a chat message. An
 * exhaustive denylist would be both impossible and misleading, and would break
 * legitimate work (PRD §15.3: do not attempt a shell sandbox — Claude Code
 * remains the execution authority).
 *
 * What a pattern actually is, measured against Claude Code 2.1.241: a LITERAL
 * COMMAND PREFIX with `*` wildcards, matched after whitespace normalisation.
 * So an equivalent spelling of the same command walks straight past — `/bin/rm
 * -rf /`, `env rm -rf /`, `rm -rfv /`, `sh -c '…'`, or a script that does it —
 * and no addition to this list can change that. Two spellings ARE listed twice
 * below, because they are the same command with the same intent and cost
 * nothing: `rm -fr` (proved to run under `Bash(rm -rf /*)` alone, with an empty
 * `permission_denials`) and `git push -f`.
 *
 * Two things deliberately NOT done here:
 *   - `Bash(rm -* /*)`, which would cover every flag order. It also denies
 *     `rm -f /some/file`, which is ordinary work, and the guardrail is meant to
 *     stop a catastrophe, not to make the Bot useless.
 *   - growing this into a long list. Length reads as completeness, and the one
 *     thing this list must never imply is that it is complete. The UI shows it
 *     verbatim, with that caveat, for exactly this reason.
 *
 * Note the real scope of `rm -rf /*`: `/*` matches any ABSOLUTE path, so it
 * denies `rm -rf /Users/me/project` as well as `rm -rf /`.
 */

/** Extra `--disallowedTools` patterns applied when `settings.safetyGuardrails` is on. */
export const SAFETY_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Bash(rm -rf /*)',
  'Bash(rm -fr /*)',
  'Bash(sudo *)',
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(shutdown*)',
  'Bash(mkfs*)',
  'Bash(dd *)',
  'Bash(:(){*)'
])

/**
 * Merge tool patterns, preserving first-seen order and dropping duplicates.
 * Claude Code accepts repeats, but a clean list keeps the spawned argv readable
 * in diagnostics.
 */
export function mergeToolPatterns(...lists: Array<readonly string[] | undefined | null>): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    if (!list) continue
    for (const entry of list) {
      const value = entry.trim()
      if (value.length === 0 || seen.has(value)) continue
      seen.add(value)
      merged.push(value)
    }
  }
  return merged
}
