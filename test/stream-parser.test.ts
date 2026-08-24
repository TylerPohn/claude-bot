/**
 * ClaudeStreamParser tests.
 *
 * Every fixture in `test/fixtures` is real captured output from Claude Code 2.1.241 -
 * not hand-written samples - so these assertions are a regression harness against the
 * actual CLI contract. The two properties that matter most:
 *
 *   1. chunk boundaries are irrelevant (the same events come out whether the stream
 *      arrives in one blob or one code point at a time);
 *   2. text is never duplicated, even though `--include-partial-messages` sends every
 *      character twice - once as a delta and once inside the final `assistant` event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type * as ParserModule from '../src/main/runtime/ClaudeStreamParser'
import type { RuntimeEvent } from '../src/shared/types/events'

// tsconfig.node.json does not enable `allowImportingTsExtensions`, and Node's type
// stripper cannot resolve the `@main/*` alias. A type-only import (erased at runtime)
// plus a URL-based dynamic import (invisible to tsc) satisfies both toolchains.
const parserUrl = new URL('../src/main/runtime/ClaudeStreamParser.ts', import.meta.url).href
const { ClaudeStreamParser, flattenToolContent } = (await import(parserUrl)) as typeof ParserModule

/* ------------------------------------------------------------------ *
 * Fixture helpers
 * ------------------------------------------------------------------ */

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** Feed the whole stream as one chunk. */
function parseWhole(text: string): RuntimeEvent[] {
  const parser = new ClaudeStreamParser()
  return [...parser.push(text), ...parser.flush()]
}

/**
 * Feed one code point at a time. Splitting by code point rather than by UTF-16 unit
 * guarantees we never hand the parser half of a surrogate pair, which would be a
 * decoding bug rather than the framing bug we are testing for.
 */
function parseByCodePoint(text: string): RuntimeEvent[] {
  const parser = new ClaudeStreamParser()
  const events: RuntimeEvent[] = []
  for (const ch of text) events.push(...parser.push(ch))
  events.push(...parser.flush())
  return events
}

/** Feed pseudo-random chunk sizes to catch off-by-one buffer slicing. */
function parseInChunks(text: string, sizes: number[]): RuntimeEvent[] {
  const parser = new ClaudeStreamParser()
  const events: RuntimeEvent[] = []
  let offset = 0
  let i = 0
  while (offset < text.length) {
    const size = sizes[i % sizes.length]!
    events.push(...parser.push(text.slice(offset, offset + size)))
    offset += size
    i++
  }
  events.push(...parser.flush())
  return events
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((event) => event.type)
}

function only<T extends RuntimeEvent['type']>(
  events: RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type)
}

/**
 * Ground truth for the de-duplication invariant: the text the model actually produced
 * is exactly the concatenation of the `text` blocks in the `assistant` events, in file
 * order. Whatever the parser emits - deltas, blocks, or a mix - must equal that string.
 */
function assistantGroundTruth(ndjson: string, field: 'text' | 'thinking'): string {
  let out = ''
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    const obj = JSON.parse(line) as Record<string, unknown>
    if (obj.type !== 'assistant') continue
    const message = obj.message as { content?: unknown } | undefined
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const typed = block as Record<string, unknown>
      if (typed.type === field && typeof typed[field] === 'string') out += typed[field] as string
    }
  }
  return out
}

function emittedText(events: RuntimeEvent[]): string {
  let out = ''
  for (const event of events) {
    if (event.type === 'text_delta' || event.type === 'text_block') out += event.text
  }
  return out
}

function emittedThinking(events: RuntimeEvent[]): string {
  let out = ''
  for (const event of events) if (event.type === 'thinking_delta') out += event.text
  return out
}

const FIXTURES = [
  'stream-basic.ndjson',
  'stream-partial.ndjson',
  'stream-mcp.ndjson',
  'stream-resume-failure.ndjson'
] as const

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

for (const name of FIXTURES) {
  test(`${name}: chunking does not change the event stream`, () => {
    const text = fixture(name)
    const whole = parseWhole(text)
    assert.deepEqual(parseByCodePoint(text), whole, 'byte-by-byte differed from one chunk')
    assert.deepEqual(parseInChunks(text, [1, 7, 3, 64, 2, 1024, 13]), whole, 'chunked differed')
    assert.ok(whole.length > 0, 'fixture produced no events')
  })

  test(`${name}: emits no parse errors`, () => {
    assert.deepEqual(only(parseWhole(fixture(name)), 'parse_error'), [])
  })

  test(`${name}: assistant text is emitted exactly once`, () => {
    const text = fixture(name)
    const events = parseWhole(text)
    assert.equal(emittedText(events), assistantGroundTruth(text, 'text'))
    assert.equal(emittedThinking(events), assistantGroundTruth(text, 'thinking'))
  })

  test(`${name}: tolerates CRLF line endings`, () => {
    const text = fixture(name)
    const crlf = text.replace(/\n/g, '\r\n')
    assert.deepEqual(parseWhole(crlf), parseWhole(text))
  })
}

/* ------------------------------------------------------------------ *
 * stream-basic: assistant text + Bash tool + result
 * ------------------------------------------------------------------ */

test('stream-basic: full normalized event sequence', () => {
  const events = parseWhole(fixture('stream-basic.ndjson'))
  assert.deepEqual(types(events), [
    'rate_limit',
    'session',
    'text_block',
    'tool_start',
    'tool_end',
    'text_block',
    'result'
  ])
})

test('stream-basic: session metadata comes from system/init', () => {
  const parser = new ClaudeStreamParser()
  const events = parser.push(fixture('stream-basic.ndjson'))
  const session = only(events, 'session')[0]
  assert.ok(session)
  assert.equal(session.sessionId, 'c323134e-f07d-4218-9aec-05d6154b1bcf')
  assert.equal(session.model, 'claude-sonnet-5')
  assert.equal(session.permissionMode, 'acceptEdits')
  assert.equal(session.cwd, '/Users/dev/Desktop/Repos/claude-bot')
  assert.equal(session.claudeCodeVersion, '2.1.241')
  assert.deepEqual(session.mcpServers, [
    { name: 'example-mcp', status: 'pending' },
    { name: 'example-tools', status: 'connected' }
  ])
  // The getter must expose the id as soon as the init line has been consumed.
  assert.equal(parser.sessionId, 'c323134e-f07d-4218-9aec-05d6154b1bcf')
})

test('stream-basic: Bash tool_use and its result are paired by tool_use_id', () => {
  const events = parseWhole(fixture('stream-basic.ndjson'))
  const start = only(events, 'tool_start')[0]
  const end = only(events, 'tool_end')[0]
  assert.ok(start && end)
  assert.equal(start.name, 'Bash')
  assert.equal(start.toolUseId, 'toolu_01Fmh9JDLaJhmQzucmWJF27c')
  assert.deepEqual(start.input, { command: 'echo hello', description: "Echo the string 'hello'" })

  assert.equal(end.toolUseId, start.toolUseId)
  assert.equal(end.isError, false)
  assert.equal(end.content, 'hello')
  // The sibling `tool_use_result` object rides along untouched as `structured`.
  assert.deepEqual(end.structured, {
    stdout: 'hello',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false
  })
})

test('stream-basic: result carries usage, cost and the resolved model', () => {
  const events = parseWhole(fixture('stream-basic.ndjson'))
  const result = only(events, 'result')[0]
  assert.ok(result)
  assert.equal(result.isError, false)
  assert.equal(result.subtype, 'success')
  assert.equal(result.resultText, 'Output: `hello`')
  assert.equal(result.sessionId, 'c323134e-f07d-4218-9aec-05d6154b1bcf')
  assert.equal(result.numTurns, 2)
  assert.equal(result.durationMs, 4906)
  assert.equal(result.costUsd, 0.0547142)
  // `modelUsage` also lists a haiku side-call; the init model is what answered.
  assert.equal(result.model, 'claude-sonnet-5')
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 94,
    cacheReadInputTokens: 58981,
    cacheCreationInputTokens: 10249
  })
  assert.deepEqual(result.permissionDenials, [])
})

test('stream-basic: rate limit state is normalized', () => {
  const events = parseWhole(fixture('stream-basic.ndjson'))
  const rate = only(events, 'rate_limit')[0]
  assert.ok(rate)
  assert.deepEqual(rate.info, {
    status: 'allowed',
    resetsAt: 1787521200,
    rateLimitType: 'five_hour'
  })
})

/* ------------------------------------------------------------------ *
 * stream-partial: deltas + the duplicate `assistant` echo
 * ------------------------------------------------------------------ */

test('stream-partial: deltas stream and the assistant echo is suppressed', () => {
  const events = parseWhole(fixture('stream-partial.ndjson'))
  assert.deepEqual(types(events), [
    'session',
    'status',
    'thinking_delta',
    'thinking_delta',
    'thinking_delta',
    'text_delta',
    'rate_limit',
    'result'
  ])

  // The decisive assertion: not one `text_block` was emitted, because every character
  // in the final `assistant` event had already been streamed as a delta.
  assert.equal(only(events, 'text_block').length, 0)

  const result = only(events, 'result')[0]
  assert.ok(result)
  assert.equal(emittedText(events), 'You asked me to echo "hello".')
  assert.equal(emittedText(events), result.resultText)
})

test('stream-partial: signature and input_json deltas are dropped', () => {
  const raw = fixture('stream-partial.ndjson')
  assert.ok(raw.includes('signature_delta'), 'fixture should contain a signature_delta')
  const events = parseWhole(raw)
  // Nothing in the emitted stream may carry the base64 signature blob.
  for (const event of events) {
    const serialized = JSON.stringify(event)
    assert.ok(!serialized.includes('EpAECrIBCBEYAipA'), `signature leaked into ${event.type}`)
  }
})

test('stream-partial: system/status becomes a status event, thinking_tokens is noise', () => {
  const events = parseWhole(fixture('stream-partial.ndjson'))
  const status = only(events, 'status')
  assert.equal(status.length, 1)
  assert.equal(status[0]!.text, 'requesting')
})

/* ------------------------------------------------------------------ *
 * stream-mcp: an MCP tool call end to end
 * ------------------------------------------------------------------ */

test('stream-mcp: full normalized event sequence', () => {
  const events = parseWhole(fixture('stream-mcp.ndjson'))
  assert.deepEqual(types(events), [
    'session',
    'rate_limit',
    'thinking_delta',
    'text_block',
    'tool_start',
    'tool_end',
    'thinking_delta',
    'tool_start',
    'tool_end',
    'thinking_delta',
    'text_block',
    'result'
  ])
})

test('stream-mcp: the mcp__ tool call and its text result survive intact', () => {
  const events = parseWhole(fixture('stream-mcp.ndjson'))
  const starts = only(events, 'tool_start')
  const ends = only(events, 'tool_end')

  assert.equal(starts[0]!.name, 'ToolSearch')
  assert.equal(starts[1]!.name, 'mcp__echotest__ping_back')
  assert.deepEqual(starts[1]!.input, { msg: 'x' })

  // `[{type:'text',text:'PONGMCP:x'}]` flattens to the plain string.
  assert.equal(ends[1]!.toolUseId, starts[1]!.toolUseId)
  assert.equal(ends[1]!.content, 'PONGMCP:x')
  assert.equal(ends[1]!.isError, false)
})

test('stream-mcp: a non-text tool_result block is preserved rather than dropped', () => {
  const events = parseWhole(fixture('stream-mcp.ndjson'))
  const end = only(events, 'tool_end')[0]
  assert.ok(end)
  // ToolSearch answers with `[{type:'tool_reference',tool_name:'...'}]`, which has no
  // `text` field. Losing it silently would make the expanded card look empty.
  assert.equal(end.content, '{"type":"tool_reference","tool_name":"mcp__echotest__ping_back"}')
  assert.deepEqual(end.structured, {
    matches: ['mcp__echotest__ping_back'],
    query: 'select:mcp__echotest__ping_back',
    total_deferred_tools: 21
  })
})

test('stream-mcp: with no partial messages, thinking still reaches the UI', () => {
  const events = parseWhole(fixture('stream-mcp.ndjson'))
  const thinking = only(events, 'thinking_delta')
  assert.equal(thinking.length, 3)
  assert.ok(thinking[0]!.text.startsWith('The user is asking me to call the ping_back tool'))
})

/* ------------------------------------------------------------------ *
 * stream-resume-failure: a dead --resume target
 * ------------------------------------------------------------------ */

test('stream-resume-failure: normalized to subtype session_not_found', () => {
  const events = parseWhole(fixture('stream-resume-failure.ndjson'))
  assert.deepEqual(types(events), ['result'])

  const result = only(events, 'result')[0]
  assert.ok(result)
  assert.equal(result.isError, true)
  assert.equal(result.subtype, 'session_not_found')
  // The echoed id is the session we asked for and which no longer exists; persisting
  // it would make the next turn fail in exactly the same way.
  assert.equal(result.sessionId, null)
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  })
})

test('stream-resume-failure: the stderr marker matches what the CLI prints', () => {
  const stderr = readFileSync(
    new URL('./fixtures/stream-resume-failure.stderr.txt', import.meta.url),
    'utf8'
  )
  assert.ok(stderr.includes('No conversation found with session ID'))
})

/* ------------------------------------------------------------------ *
 * Robustness
 * ------------------------------------------------------------------ */

test('a corrupt line yields parse_error and does not stop the stream', () => {
  const lines = fixture('stream-basic.ndjson').split('\n').filter(Boolean)
  const corrupted = [lines[0]!, '{"type":"assistant", "message": {broken', ...lines.slice(1)].join(
    '\n'
  )

  let events: RuntimeEvent[] = []
  assert.doesNotThrow(() => {
    events = parseWhole(corrupted)
  })

  const errors = only(events, 'parse_error')
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.raw.startsWith('{"type":"assistant"'))
  assert.ok(errors[0]!.error.length > 0)

  // Everything after the bad line still parses normally.
  assert.deepEqual(types(events), [
    'rate_limit',
    'parse_error',
    'session',
    'text_block',
    'tool_start',
    'tool_end',
    'text_block',
    'result'
  ])
})

test('a truncated line split across many pushes is reassembled', () => {
  const line = fixture('stream-basic.ndjson').split('\n')[1]! // the system/init line
  const parser = new ClaudeStreamParser()
  const events: RuntimeEvent[] = []
  for (let i = 0; i < line.length; i += 17) {
    events.push(...parser.push(line.slice(i, i + 17)))
  }
  // Not `deepEqual(events, [])`: node's assert types narrow `events` to `never[]`.
  assert.equal(events.length, 0, 'no event may be emitted before the newline arrives')
  events.push(...parser.push('\n'))
  assert.deepEqual(types(events), ['session'])
})

test('flush() emits a trailing line that never got a newline', () => {
  const parser = new ClaudeStreamParser()
  assert.deepEqual(parser.push('{"type":"system","subtype":"status","status":"requesting"}'), [])
  assert.deepEqual(parser.flush(), [{ type: 'status', text: 'requesting' }])
  // Flushing again is harmless.
  assert.deepEqual(parser.flush(), [])
})

test('unknown event types and blank lines produce nothing', () => {
  const parser = new ClaudeStreamParser()
  const events = parser.push(
    [
      '',
      '   ',
      '{"type":"some_future_event","payload":{"a":1}}',
      '{"type":"stream_event","event":{"type":"future_frame"}}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"redacted_thinking"}]}}',
      '[1,2,3]',
      ''
    ].join('\n')
  )
  assert.deepEqual(events, [])
})

test('a partial stream cut off mid-block emits only the untransmitted tail', () => {
  // Synthetic: the deltas stop after "Hello", then the `assistant` event arrives with
  // the full block. Only " world" is new, so only " world" may be emitted.
  const parser = new ClaudeStreamParser()
  const events = parser.push(
    [
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_x"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}',
      '{"type":"assistant","message":{"id":"msg_x","content":[{"type":"text","text":"Hello world"}]}}',
      ''
    ].join('\n')
  )
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'Hello' },
    { type: 'text_block', text: ' world' }
  ])
})

test('multiple text blocks in one message are accounted cumulatively', () => {
  // Blocks 0 and 2 are text with a tool_use between them; both were streamed, so the
  // two `assistant` echoes must add nothing.
  const parser = new ClaudeStreamParser()
  const events = parser.push(
    [
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_y"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AA"}}}',
      '{"type":"assistant","message":{"id":"msg_y","content":[{"type":"text","text":"AA"}]}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"BBB"}}}',
      '{"type":"assistant","message":{"id":"msg_y","content":[{"type":"text","text":"BBB"}]}}',
      ''
    ].join('\n')
  )
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'AA' },
    { type: 'text_delta', text: 'BBB' }
  ])
})

test('a new message id resets the de-duplication accounting', () => {
  const parser = new ClaudeStreamParser()
  const events = parser.push(
    [
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"first"}]}}',
      '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m2"}}}',
      '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"second"}]}}',
      ''
    ].join('\n')
  )
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'first' },
    { type: 'text_block', text: 'second' }
  ])
})

test('tool_result content is flattened from strings and block arrays alike', () => {
  assert.equal(flattenToolContent('plain'), 'plain')
  assert.equal(flattenToolContent(null), '')
  assert.equal(
    flattenToolContent([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' }
    ]),
    'one\ntwo'
  )
  assert.equal(flattenToolContent({ some: 'object' }), '{"some":"object"}')
  // Oversized output is capped rather than shipped whole to the renderer.
  const huge = flattenToolContent('x'.repeat(50_000))
  assert.ok(huge.length < 50_000)
  assert.ok(huge.endsWith('truncated ...'))
})

test('a tool_result flagged is_error is reported as an error', () => {
  const parser = new ClaudeStreamParser()
  const events = parser.push(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"boom","is_error":true}]},"tool_use_result":{"stdout":"","stderr":"boom"}}\n'
  )
  assert.deepEqual(events, [
    {
      type: 'tool_end',
      toolUseId: 't1',
      isError: true,
      content: 'boom',
      structured: { stdout: '', stderr: 'boom' }
    }
  ])
})
