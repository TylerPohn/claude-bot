/**
 * `isExecutablePath` — the gate in front of every `shell.openPath`.
 *
 * The bar these enforce is the one an attachment chip depends on: clicking a
 * chip previews a document and NEVER runs a program. Two real defects are
 * pinned here so they cannot come back.
 *
 *   1. Extension-only gating. `Q3-report` at mode 0755 with `#!/bin/sh` on the
 *      first line is the ordinary shape of a Unix executable and matches nothing
 *      on the denylist; macOS types it `public.unix-executable` and ran it.
 *   2. `path.extname` disagreeing with the OS about attacker-controlled names.
 *      `extname('Quarterly Report.pdf ')` is `'.pdf '`, which the old code read
 *      as "has an extension, so the OS types it by extension, not by the mode
 *      bits". macOS reads the trailing space as no usable extension at all and
 *      falls back to the mode bits — measured with `mdls`, `public.unix-
 *      executable` — so one click on a chip that rendered as "Quarterly
 *      Report.pdf" (HTML collapses the trailing space, and so does the native
 *      tooltip) was arbitrary code execution. `payload.command.` is the same
 *      hole through a trailing dot, and on Windows it is worse: Win32 strips
 *      trailing dots and spaces, so the file ShellExecute opens really is
 *      `payload.command`.
 *
 * These write real files rather than stubbing `fs`: the whole question is what
 * the filesystem says about a name, so a fake would only test the fake.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore TS5097 — see the note in test/mentions.test.ts
import {
  effectiveExtension,
  isDirectoryPath,
  isExecutablePath,
  usableExtension
} from '../src/main/lib/executablePath.ts'

/** Mode bits are a POSIX concept; Node reports none on Windows. */
const POSIX = process.platform !== 'win32'

const root = mkdtempSync(join(tmpdir(), 'ccb-exec-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

/** Writes a shell payload at `name` and returns its path. */
function file(name: string, mode: number): string {
  const path = join(root, name)
  writeFileSync(path, '#!/bin/sh\necho pwned\n', { mode })
  return path
}

function dir(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

function link(name: string, target: string): string {
  const path = join(root, name)
  symlinkSync(target, path)
  return path
}

/* ------------------------------------------------------------------ *
 * The two normalisers
 * ------------------------------------------------------------------ */

test('effectiveExtension reads the name the OS reads, not the one extname reads', () => {
  // Win32 strips trailing dots and spaces off the component before resolving,
  // so all three of these open the file `payload.command`.
  assert.equal(effectiveExtension('payload.command'), '.command')
  assert.equal(effectiveExtension('payload.command.'), '.command')
  assert.equal(effectiveExtension('payload.command '), '.command')
  assert.equal(effectiveExtension('payload.command. . '), '.command')
  // Ordinary names are classified exactly as they were before the fix.
  assert.equal(effectiveExtension('notes.pdf'), '.pdf')
  assert.equal(effectiveExtension('REPORT.PDF'), '.pdf')
  assert.equal(effectiveExtension('archive.tar.gz'), '.gz')
  assert.equal(effectiveExtension('.zshrc'), '')
  assert.equal(effectiveExtension('Makefile'), '')
  // A trailing separator must not hide the real component.
  assert.equal(effectiveExtension('/tmp/Some.app/'), '.app')
})

test('usableExtension is empty exactly when the OS falls back to the mode bits', () => {
  // Measured with `mdls -name kMDItemContentType` on 0755 files: an extension
  // that is empty or contains a space types the file public.unix-executable.
  assert.equal(usableExtension('Quarterly Report.pdf '), '')
  assert.equal(usableExtension('payload.command.'), '')
  assert.equal(usableExtension('report.p df'), '')
  assert.equal(usableExtension('report. pdf'), '')
  assert.equal(usableExtension('Q3-report'), '')
  assert.equal(usableExtension('.zshrc'), '')
  // Everything else is typed by its extension, including unregistered and
  // punctuated ones (macOS gives those a dyn.* UTI and never executes them).
  assert.equal(usableExtension('notes.pdf'), '.pdf')
  assert.equal(usableExtension('REPORT.PDF'), '.pdf')
  assert.equal(usableExtension('notes.dat'), '.dat')
  assert.equal(usableExtension('main.c++'), '.c++')
  assert.equal(usableExtension('archive.tar.gz'), '.gz')
  // A space before the dot is in the stem, not the extension.
  assert.equal(usableExtension('Quarterly Report.pdf'), '.pdf')
})

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

test('refuses a denylisted extension, however the name is spelled', () => {
  assert.equal(isExecutablePath(file('payload.command', 0o755)), true)
  assert.equal(isExecutablePath(file('payload.command.', 0o755)), true)
  assert.equal(isExecutablePath(file('payload.command ', 0o755)), true)
  assert.equal(isExecutablePath(file('payload.sh.', 0o644)), true)
  // The denylist runs before any stat, so a name that does not exist yet is
  // still refused rather than quietly allowed.
  assert.equal(isExecutablePath(join(root, 'never-created.command')), true)
})

test('refuses a trailing-space name whose mode bits make it executable', { skip: !POSIX }, () => {
  // The one-click RCE. extname() says '.pdf ' — non-empty — so the old gate
  // returned false here and shell.openPath ran the script.
  const path = file('Quarterly Report.pdf ', 0o755)
  assert.equal(isExecutablePath(path), true)
  // Same file at document permissions is a document: nothing executes it, and
  // the gate must not start refusing ordinary attachments.
  assert.equal(isExecutablePath(file('Quarterly Report.pdf  ', 0o644)), false)
})

test('refuses an extension-less executable, allows an extension-less document', { skip: !POSIX }, () => {
  assert.equal(isExecutablePath(file('Q3-report', 0o755)), true)
  assert.equal(isExecutablePath(file('LICENSE', 0o644)), false)
})

test('lets an ordinary document through even at mode 0755', { skip: !POSIX }, () => {
  // Whole volumes come back 0755 (exFAT/SMB mounts, an unpacked archive). The
  // extension decides the type for these, so gating on the bit alone would
  // refuse to open perfectly ordinary files off a USB stick.
  assert.equal(isExecutablePath(file('notes.pdf', 0o755)), false)
  assert.equal(isExecutablePath(file('notes.dat', 0o755)), false)
  assert.equal(isExecutablePath(file('main.c++', 0o755)), false)
  assert.equal(isExecutablePath(file('REPORT.PDF', 0o644)), false)
})

test('follows a symlink: the target decides, by name or by mode', { skip: !POSIX }, () => {
  // A well-formed link name pointing at a denylisted target.
  assert.equal(isExecutablePath(link('statement.pdf', file('t-payload.command', 0o755))), true)
  // A well-formed link name pointing at an extension-less executable: neither
  // name is on the denylist, so only the mode test catches this one.
  assert.equal(isExecutablePath(link('invoice.pdf', file('t-payload', 0o755))), true)
  // A well-formed link name pointing at a trailing-space executable.
  assert.equal(isExecutablePath(link('receipt.pdf', file('t-payload.pdf ', 0o755))), true)
  // A link to a real document is a document.
  assert.equal(isExecutablePath(link('summary.pdf', file('t-notes.pdf', 0o644))), false)
  // Nothing to run, and openPath will report the breakage itself.
  assert.equal(isExecutablePath(link('broken.pdf', join(root, 'does-not-exist'))), false)
})

test('a directory is never executable, but a bundle is', () => {
  const folder = dir('Working Folder')
  assert.equal(isExecutablePath(folder), false)
  assert.equal(isDirectoryPath(folder), true)
  // `.app` is a directory too — the denylist is what catches it, which is why
  // openTerminalAt needs both predicates and not just isDirectoryPath.
  const bundle = dir('Evil.app')
  assert.equal(isExecutablePath(bundle), true)
  assert.equal(isDirectoryPath(bundle), true)
})

test('isDirectoryPath reports unreadable paths as not-a-directory', () => {
  assert.equal(isDirectoryPath(join(root, 'nothing-here')), false)
  assert.equal(isDirectoryPath(file('plain.txt', 0o644)), false)
})
