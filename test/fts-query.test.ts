import test from 'node:test'
import assert from 'node:assert/strict'
// Node's type stripper needs the real file extension; `allowImportingTsExtensions`
// is off in the shared tsconfig, so the import specifier is silenced for tsc only.
// @ts-ignore TS5097
import { sanitizeFtsQuery } from '../src/main/db/repositories/ftsQuery.ts'

test('quotes each word and prefix-matches only the last one', () => {
  assert.equal(sanitizeFtsQuery('auth bug'), '"auth" "bug"*')
})

test('keeps a hyphenated term intact', () => {
  // The regression this file exists for: the old sanitizer deleted the hyphen
  // and searched for `electronbuilder`, a token FTS5 never indexes, so every
  // hyphenated package name, CLI flag and compound term returned zero hits.
  assert.equal(sanitizeFtsQuery('electron-builder'), '"electron-builder"*')
  assert.equal(sanitizeFtsQuery('auto-update fails'), '"auto-update" "fails"*')
  assert.equal(sanitizeFtsQuery('better-sqlite3'), '"better-sqlite3"*')
})

test('leaves other FTS5 syntax characters inside the phrase', () => {
  // Safe because FTS5 re-tokenizes the text inside a quoted phrase, so none of
  // these is read as an operator.
  assert.equal(sanitizeFtsQuery('auth('), '"auth("*')
  assert.equal(sanitizeFtsQuery('a:b'), '"a:b"*')
  assert.equal(sanitizeFtsQuery('col^2 *star*'), '"col^2" "*star*"*')
})

test('double quotes become separators so a phrase can never be broken out of', () => {
  assert.equal(sanitizeFtsQuery('"auth"'), '"auth"*')
  assert.equal(sanitizeFtsQuery('a"b'), '"a" "b"*')
  // The classic break-out attempt: nothing survives that could close the phrase.
  const injected = sanitizeFtsQuery('x" OR messages_fts MATCH "y')
  assert.equal(injected, '"x" "OR" "messages_fts" "MATCH" "y"*')
  assert.equal(injected!.split('"').length % 2, 1, 'quotes must stay balanced')
})

test('bare boolean operators are searched as ordinary words', () => {
  // Quoting already demotes them; the old bareword filter only lost real hits.
  assert.equal(sanitizeFtsQuery('AND'), '"AND"*')
  assert.equal(sanitizeFtsQuery('NOT NEAR'), '"NOT" "NEAR"*')
})

test('control characters are stripped without splitting the word', () => {
  // snippet() marks hits with U+0001/U+0002; pasting a snippet back in must
  // search for the word, not for two halves of it.
  assert.equal(sanitizeFtsQuery('\u0001auth\u0002'), '"auth"*')
  assert.equal(sanitizeFtsQuery('au\u0007th'), '"auth"*')
})

test('returns null when nothing searchable survives', () => {
  // The caller must not run an empty MATCH — that is an FTS5 syntax error.
  assert.equal(sanitizeFtsQuery(''), null)
  assert.equal(sanitizeFtsQuery('   '), null)
  assert.equal(sanitizeFtsQuery('""""'), null)
  assert.equal(sanitizeFtsQuery('\u0000\u001f'), null)
})

test('caps a pasted wall of text at 24 terms', () => {
  const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
  const out = sanitizeFtsQuery(many)
  assert.equal(out!.split(' ').length, 24)
  assert.ok(out!.endsWith('"w23"*'))
})
