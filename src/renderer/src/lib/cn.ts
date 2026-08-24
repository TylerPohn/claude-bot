/**
 * Minimal class-name joiner. Deliberately not `clsx` + `tailwind-merge`:
 * this app's components own their classes, so conflict resolution is never
 * needed and the two extra dependencies are not worth the bundle.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    out = out ? out + ' ' + p : p
  }
  return out
}
