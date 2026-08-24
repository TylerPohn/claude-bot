import test from 'node:test'
import assert from 'node:assert/strict'
// Node's type stripper needs the real file extension; `allowImportingTsExtensions`
// is off in the shared tsconfig, so the import specifier is silenced for tsc only.
// @ts-ignore TS5097
import { SPLIT_CACHE_SIZE, splitMarkdownBlocks } from '../src/renderer/src/components/chat/markdownBlocks.ts'

/**
 * `splitMarkdownBlocks` keeps a small incremental cache so a streaming reply
 * re-scans only its tail. THE PROPERTY THAT MATTERS is that the cache is
 * invisible: the blocks a reader watches arrive character by character must be
 * the blocks they get when the same message is rendered cold after a reload.
 *
 * The regression these guard: the cache used to restart at the LAST block only,
 * so a boundary created at one prefix could never be taken back at the next. A
 * continuation line beginning `*` (a lone `*` interrupts a paragraph, `**` does
 * not) split one paragraph in two for the rest of the turn — visible as an extra
 * 10px `.md-block` gap that vanished on the next cold render.
 */

/**
 * Evict everything, the way other messages re-rendering would.
 *
 * It takes a full set of distinct bodies now that the cache holds one entry per
 * streaming message: a single buster would leave the entry these tests just
 * wrote, and `coldSplit` would hand back the streamed result it is supposed to
 * be checked against — a test that can only ever pass.
 */
function flushCache(): void {
  for (let i = 0; i < SPLIT_CACHE_SIZE; i += 1) {
    splitMarkdownBlocks(`cache buster ${i}\n\nsecond block\n`)
  }
}

/** Bust the module-level cache the way another message re-rendering would. */
function coldSplit(source: string): string[] {
  flushCache()
  return splitMarkdownBlocks(source)
}

/** Feed `source` one character at a time, as a stream of deltas would. */
function streamSplit(source: string): string[] {
  flushCache()
  let out: string[] = []
  for (let i = 1; i <= source.length; i += 1) out = splitMarkdownBlocks(source.slice(0, i))
  return out
}

const CASES: Array<[string, string]> = [
  [
    'bold continuation line (a lone `*` interrupts, `**` does not)',
    'Here is the summary:\n**Note:** check the config first.\nThen run the tests.'
  ],
  ['emphasis continuation line', 'Two options:\n*fast* but risky, or slow and safe.'],
  ['number continuation line (only `1.` may interrupt)', 'We saw growth of\n1.5 million users.'],
  ['hash continuation line', 'Try the tag\n#hashtag when you post.'],
  ['a real list still splits', 'Pick one:\n- fast\n- safe'],
  ['a real heading still splits', 'Intro paragraph.\n# Heading\nBody.'],
  ['fenced code', 'Before:\n\n```ts\nconst x = 1\n```\n\nAfter.'],
  ['unclosed html holds everything in one block', 'Intro\n\n<div>\n\nStill inside.\n'],
  ['table', 'Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.'],
  ['setext heading', 'Lead in.\n\nTitle\n=====\n\nBody.']
]

for (const [name, source] of CASES) {
  test(`streamed and cold splits agree: ${name}`, () => {
    assert.deepEqual(streamSplit(source), coldSplit(source))
  })
}

test('every split is lossless, streamed or cold', () => {
  for (const [, source] of CASES) {
    assert.equal(streamSplit(source).join(''), source)
    assert.equal(coldSplit(source).join(''), source)
  }
})

test('an append that un-creates a boundary is taken back', () => {
  // The exact moment the old cache froze: at "…summary:\n*" the lone `*` is a
  // bullet and opens a second block; the next character makes it `**`, which is
  // just text, and the paragraph must become whole again.
  splitMarkdownBlocks('cache buster\n\nsecond block\n')
  const opened = splitMarkdownBlocks('Here is the summary:\n*')
  assert.equal(opened.length, 2, 'a lone * does interrupt the paragraph')
  const closed = splitMarkdownBlocks('Here is the summary:\n**')
  assert.deepEqual(closed, ['Here is the summary:\n**'])
})

test('appending to a long body still reuses the cache', () => {
  // Guards the optimisation itself: rescanning from the second-to-last block
  // must not turn into a full re-split. Every block before the tail keeps its
  // identity, which is what `React.memo` on `raw` depends on.
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i}.`).join('\n\n')
  const before = splitMarkdownBlocks(body)
  const after = splitMarkdownBlocks(`${body} and a few more words`)
  assert.equal(before.length, 40)
  assert.equal(after.length, 40)
  for (let i = 0; i < before.length - 2; i += 1) {
    assert.ok(before[i] === after[i], `block ${i} should be reference-identical`)
  }
})

test('several messages streaming at once each keep their own cache entry', () => {
  // The group-chat case the cache exists for: four Bots flushing deltas into the
  // same renderer, so consecutive calls come from DIFFERENT messages. Each one
  // must still split exactly as it would alone — and must still hit its own
  // entry, which is what `React.memo` on `raw` depends on.
  const bodies = ['alpha', 'bravo', 'charlie', 'delta'].map((name) =>
    [
      `Intro from ${name}.`,
      '```ts\nconst x = 1\n```',
      `Then ${name} explains:\n- one\n- two`,
      `Closing note from ${name}.`
    ].join('\n\n')
  )

  const alone = bodies.map((body) => coldSplit(body))

  flushCache()
  const sources = bodies.map(() => '')
  let interleaved: string[][] = bodies.map(() => [])
  let pending = true
  while (pending) {
    pending = false
    for (let i = 0; i < bodies.length; i += 1) {
      const body = bodies[i]!
      if (sources[i]!.length >= body.length) continue
      pending = true
      sources[i] = body.slice(0, sources[i]!.length + 7)
      interleaved[i] = splitMarkdownBlocks(sources[i]!)
    }
  }

  for (let i = 0; i < bodies.length; i += 1) {
    assert.deepEqual(interleaved[i], alone[i], `message ${i} split differently while interleaved`)
    assert.equal(interleaved[i]!.join(''), bodies[i])
  }

  // And the entries survived each other. A hit returns the cached ARRAY itself,
  // which is the one thing a test can tell apart from a cold re-split — block
  // strings compare equal either way. With a single shared entry the first three
  // messages have been evicted by the fourth and every one of these is a fresh
  // array, which is exactly the thrash this asserts against.
  for (let i = 0; i < bodies.length; i += 1) {
    assert.ok(
      splitMarkdownBlocks(bodies[i]!) === interleaved[i],
      `message ${i} was evicted by the others streaming beside it`
    )
  }
})
