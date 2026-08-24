/**
 * "Would the OS RUN this path?" — the gate in front of every `shell.openPath`
 * and every terminal launch.
 *
 * This lives in its own module for two reasons. It is the single highest-risk
 * predicate in the app (a wrong answer is arbitrary code execution from one
 * click on an attachment chip), and it has to be UNIT TESTABLE: the suite runs
 * main sources directly under `node --test --experimental-strip-types`, which
 * can resolve neither `electron` nor the `@main/*` aliases. So this file imports
 * nothing but `node:fs` and `node:path` and must stay that way.
 */
import { realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * Extensions the OS RUNS rather than opens in a viewer.
 *
 * `shell.openPath` is LaunchServices / ShellExecute: handed a `.command` it
 * executes it, no prompt. Attachment paths are not all first-party — an imported
 * backup supplies both the path and the friendly `name` shown on the chip — so a
 * chip reading "Q3-report.pdf" could point at `payload.command` and one click
 * would run it. The union of all three platforms' lists is used everywhere: a
 * backup written on Windows can be restored on a Mac, and refusing `.exe` on
 * macOS costs nothing.
 *
 * This is a gate on the ACTION, not on the importer, so it also covers paths
 * that arrive through any future route into `openPath`.
 *
 * The list is only half the gate: an executable does not need an extension at
 * all, and a name can be spelled so that the extension the OS reads is not the
 * one `path.extname` reads. `isExecutablePath` below is the whole rule.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // macOS
  '.app', '.command', '.tool', '.scpt', '.scptd', '.applescript', '.workflow', '.terminal',
  '.action', '.osax', '.prefpane', '.pkg', '.mpkg', '.dmg',
  // Windows
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.msi', '.msp', '.scr', '.pif', '.lnk',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.msc', '.reg', '.inf',
  // Unix-ish, and interpreted scripts anywhere
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish', '.run', '.bin', '.appimage', '.desktop',
  '.py', '.pl', '.rb', '.php', '.jar',
  // Indirection files: the OS follows these somewhere else and may launch what
  // it finds. `.lnk` was already here; these are the same class and were not.
  '.url', '.webloc', '.inetloc'
])

/**
 * The extension the OS will act on, after the OS's own name canonicalisation.
 *
 * Win32 strips trailing dots and spaces off every path component before it
 * resolves anything, so `payload.command.` and `payload.command ` both open the
 * file `payload.command` and ShellExecute runs it — while `path.extname` reports
 * `.` and `.command ` and the denylist misses. Stripping the same characters
 * here makes the denylist see the name the OS sees.
 *
 * `basename` first so a trailing separator (`/tmp/thing.app/`) cannot hide the
 * real component, and because the strip must only ever apply to the last one.
 */
export function effectiveExtension(path: string): string {
  return extname(basename(path).replace(/[. ]+$/, '')).toLowerCase()
}

/**
 * The extension only if the OS will actually TYPE the file by it.
 *
 * macOS decides a file's type from its extension when it has a usable one, and
 * otherwise falls back to the execute bit and types the file
 * `public.unix-executable` — which LaunchServices runs. Measured on this
 * machine with `mdls -name kMDItemContentType` against 0755 files:
 *
 *     a.pdf   -> com.adobe.pdf            a.dat  -> dyn.…      (typed: safe)
 *     a.c++   -> public.c-plus-plus-source a.tar~ -> dyn.…      (typed: safe)
 *     a.pdf   (ONE TRAILING SPACE)        -> public.unix-executable
 *     a.p df  (space anywhere in the ext) -> public.unix-executable
 *     a.pdf.  / a..  (empty extension)    -> public.unix-executable
 *
 * So the rule is narrow and empirical: an extension is unusable when it is
 * EMPTY or contains WHITESPACE. Everything else — punctuation, non-ASCII,
 * unregistered extensions — gets a dynamic UTI and is never executed.
 *
 * This is what the old code got wrong, and it was a one-click RCE. It asked
 * `extname(p) !== ''` and concluded "it has an extension, so the OS resolves by
 * extension, not by the mode bits". `extname('Quarterly Report.pdf ')` is
 * `'.pdf '` — not empty — so a 0755 `#!/bin/sh` file whose chip rendered as
 * "Quarterly Report.pdf" (HTML and the native tooltip both collapse the
 * trailing space) sailed past the gate and `shell.openPath` ran it. Returning
 * `''` for those names is what routes them to the mode test below.
 *
 * Only the ASCII space is observed to trigger the macOS fallback, but all
 * whitespace is refused a "usable" verdict: it costs nothing real (no document
 * has a tab in its extension) and an unusable verdict is never itself a
 * decision — it only means "ask the mode bits instead".
 */
export function usableExtension(path: string): string {
  const raw = extname(basename(path)).toLowerCase()
  const body = raw.startsWith('.') ? raw.slice(1) : raw
  return body.length > 0 && !/\s/.test(body) ? raw : ''
}

/**
 * True when the OS would treat this path as something to execute.
 *
 * Three tests, because the OS uses three:
 *
 *  1. The canonicalised EXTENSION, on the given path AND on the resolved one — a
 *     symlink named `report.pdf` pointing at `payload.command` would otherwise
 *     sail through, and on macOS LaunchServices follows the link.
 *  2. The EXECUTE BIT on a regular file, whenever either name lacks an extension
 *     the OS can type the file by.
 *
 * (2) is the hole this function used to have, and it was the worst defect in the
 * app: the check was extension-only, so `Q3-report` — mode 0755, `#!/bin/sh` on
 * the first line, which is the ordinary shape of a Unix executable — matched
 * nothing on the list. macOS gives such a file `public.unix-executable` and
 * `shell.openPath` RAN it, so one click on an attachment chip whose affordance
 * is "preview this file" was arbitrary code execution. A symlink
 * `statement.pdf` -> extension-less `payload` executes the same way, which is
 * why EITHER name lacking a usable extension has to reach the mode test.
 *
 * The execute bit is deliberately not the primary test. When a name HAS a usable
 * extension the extension decides the type: a 0755 `report.pdf` is still
 * `com.adobe.pdf` and opens in Preview, and whole volumes come back mode 0755
 * (exFAT/MS-DOS/SMB mounts, an archive unpacked with its modes). Gating on the
 * bit alone would refuse to open perfectly ordinary documents off a USB stick.
 * Extension-less documents are safe by the same measurement — `LICENSE` and
 * `Makefile` are 0644 `public.plain-text`.
 *
 * On Windows the mode test is inert (Node reports no execute bits there, and
 * ShellExecute needs a PATHEXT extension anyway), so it needs no platform guard
 * — but that inertness is exactly why (1) canonicalises the name the Win32 way
 * before consulting the denylist. Without it `payload.command.` was refused by
 * neither test on Windows.
 */
export function isExecutablePath(path: string): boolean {
  if (EXECUTABLE_EXTENSIONS.has(effectiveExtension(path))) return true

  let target: string
  try {
    target = realpathSync(path)
  } catch {
    // Broken link or gone: nothing to run, and openPath will report it.
    return false
  }
  if (EXECUTABLE_EXTENSIONS.has(effectiveExtension(target))) return true

  // Both names carry an extension the OS can type the file by, and neither is on
  // the list above: the extension, not the mode, is what the OS will act on.
  if (usableExtension(path) !== '' && usableExtension(target) !== '') return false

  // Stat the RESOLVED path so the mode is the target's rather than the link's.
  // Directories are excluded: every folder is mode-executable and `openPath`
  // should show it. (`.app` bundles are directories too, but the extension test
  // above has already caught them.)
  const stats = statSync(target, { throwIfNoEntry: false })
  return stats?.isFile() === true && (stats.mode & 0o111) !== 0
}

/**
 * True only for a real directory. `statSync` follows symlinks, which is what we
 * want: a link to a folder is a folder. Anything unreadable is reported as "not
 * a directory" so the caller refuses rather than guessing.
 */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
