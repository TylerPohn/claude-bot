/**
 * ActivityMapper tests.
 *
 * The bar these enforce is the product bar from PRD section 16: an activity card
 * headline is a short human phrase, never a tool name plus serialized arguments, and
 * never raw JSON. The fixture-driven cases at the bottom run real captured Claude Code
 * tool events through the mapper so the two modules stay in agreement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Activity } from '../src/shared/types'
import type * as MapperModule from '../src/main/runtime/ActivityMapper'
import type * as ParserModule from '../src/main/runtime/ClaudeStreamParser'
import type { RuntimeEvent } from '../src/shared/types/events'

// See the note in stream-parser.test.ts: type-only import for tsc, URL import for Node.
const mapperUrl = new URL('../src/main/runtime/ActivityMapper.ts', import.meta.url).href
const parserUrl = new URL('../src/main/runtime/ClaudeStreamParser.ts', import.meta.url).href
const { mapToolStart, mapToolEnd, summarizeActivities, parseMcpToolName, displayPath } =
  (await import(mapperUrl)) as typeof MapperModule
const { ClaudeStreamParser } = (await import(parserUrl)) as typeof ParserModule

const CWD = '/repo'

/* ------------------------------------------------------------------ *
 * mapToolStart — the quality bar
 * ------------------------------------------------------------------ */

test('Bash is titled by its command', () => {
  const activity = mapToolStart('Bash', { command: 'npm test' }, CWD)
  assert.equal(activity.type, 'command')
  assert.equal(activity.title, 'npm test')
  assert.equal(activity.toolName, 'Bash')
})

test('a multi-line Bash command collapses into a single-line title', () => {
  const command = 'cd packages/app \\\n  && npm run build \\\n  && npm test'
  const activity = mapToolStart('Bash', { command, description: 'Build and test' }, CWD)
  assert.ok(!activity.title.includes('\n'))
  assert.equal(activity.title, 'cd packages/app \\ && npm run build \\ && npm test')
  assert.equal(activity.subtitle, 'Build and test')
  // The untouched command is still available behind the expander.
  assert.equal(activity.detail, command)
})

test('Read is titled by the path relative to the workspace', () => {
  const activity = mapToolStart('Read', { file_path: '/repo/src/app.ts' }, CWD)
  assert.equal(activity.type, 'file_read')
  assert.equal(activity.title, 'src/app.ts')
})

test('Edit reports the file and an estimated line delta', () => {
  const activity = mapToolStart(
    'Edit',
    {
      file_path: '/repo/src/app.ts',
      old_string: 'a\nb\nc',
      new_string: Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    },
    CWD
  )
  assert.equal(activity.type, 'file_edit')
  assert.equal(activity.title, 'src/app.ts')
  assert.equal(activity.subtitle, '+12 -3')
  assert.equal(activity.addedLines, 12)
  assert.equal(activity.removedLines, 3)
})

test('Grep is titled by its pattern and scoped by its subtitle', () => {
  const activity = mapToolStart('Grep', { pattern: 'useState', path: 'src' }, CWD)
  assert.equal(activity.type, 'search')
  assert.equal(activity.title, 'useState')
  assert.equal(activity.subtitle, 'in src')
})

test('WebFetch is titled by host, WebSearch by query', () => {
  const fetched = mapToolStart('WebFetch', { url: 'https://x' }, CWD)
  assert.equal(fetched.type, 'web')
  assert.equal(fetched.title, 'x')

  const withPath = mapToolStart('WebFetch', { url: 'https://www.example.com/docs/api' }, CWD)
  assert.equal(withPath.title, 'example.com')
  assert.equal(withPath.subtitle, '/docs/api')

  const searched = mapToolStart('WebSearch', { query: 'electron ipc security' }, CWD)
  assert.equal(searched.type, 'web')
  assert.equal(searched.title, 'electron ipc security')
})

test('Task is titled by its description', () => {
  const activity = mapToolStart(
    'Task',
    { description: 'find bugs', subagent_type: 'general-purpose', prompt: 'Look for bugs.' },
    CWD
  )
  assert.equal(activity.type, 'task')
  assert.equal(activity.title, 'find bugs')
  assert.equal(activity.subtitle, 'general-purpose')
})

test('TodoWrite reads as a plan update', () => {
  const activity = mapToolStart(
    'TodoWrite',
    {
      todos: [
        { content: 'Write parser', status: 'completed' },
        { content: 'Write tests', status: 'in_progress' }
      ]
    },
    CWD
  )
  assert.equal(activity.type, 'todo')
  assert.equal(activity.title, 'Updated plan')
  assert.equal(activity.subtitle, '1/2 done')
  assert.equal(activity.detail, '[x] Write parser\n[~] Write tests')
})

test('MCP tools are titled "<server> / <tool>"', () => {
  const github = mapToolStart('mcp__github__create_issue', { title: 'Bug' }, CWD)
  assert.equal(github.type, 'mcp')
  assert.equal(github.title, 'github / create_issue')

  // Our own bridge server name contains underscores; the split must not be greedy.
  const bridge = mapToolStart('mcp__claude_bot__send_message_to_bot', {}, CWD)
  assert.equal(bridge.title, 'claude_bot / send_message_to_bot')
})

test('parseMcpToolName splits on the first double underscore only', () => {
  assert.deepEqual(parseMcpToolName('mcp__github__create_issue'), {
    server: 'github',
    tool: 'create_issue'
  })
  assert.deepEqual(parseMcpToolName('mcp__claude_bot__list_bots'), {
    server: 'claude_bot',
    tool: 'list_bots'
  })
  assert.equal(parseMcpToolName('Bash'), null)
  assert.equal(parseMcpToolName('mcp__onlyserver'), null)
})

test('an unknown tool degrades to a readable label, never to JSON', () => {
  const activity = mapToolStart('Frobnicate', { widget: 3 }, CWD)
  assert.equal(activity.type, 'tool')
  assert.equal(activity.title, 'Used Frobnicate')
  // The payload is still inspectable, just not in the headline.
  assert.ok(activity.detail?.includes('widget'))
})

test('titles never serialize the tool input, even when it is malformed', () => {
  const cases: Array<[string, unknown]> = [
    ['Bash', { command: 'ls -la', description: 'List files' }],
    ['Read', null],
    ['Edit', 'not-an-object'],
    ['Grep', {}],
    ['mcp__srv__tool', { a: { b: [1, 2, 3] } }],
    ['Unknown', { nested: { deep: true } }]
  ]
  for (const [name, input] of cases) {
    const activity = mapToolStart(name, input, CWD)
    assert.ok(activity.title.length > 0, `${name} produced an empty title`)
    assert.ok(!activity.title.includes('{'), `${name} leaked JSON into its title`)
    assert.ok(!activity.title.includes('\n'), `${name} produced a multi-line title`)
  }
})

test('a shell command that happens to be JSON is still shown verbatim', () => {
  // The rule is "never serialize the *input object*", not "never show braces": a user
  // running `echo '{"a":1}'` should see exactly that on the card.
  const activity = mapToolStart('Bash', { command: `echo '{"a":1}'` }, CWD)
  assert.equal(activity.title, `echo '{"a":1}'`)
})

test('paths outside the workspace are shown absolute, not as ../.. chains', () => {
  const activity = mapToolStart('Read', { file_path: '/etc/hosts' }, CWD)
  assert.equal(activity.title, '/etc/hosts')
  assert.equal(displayPath('/repo/src/app.ts', '/repo'), 'src/app.ts')
  assert.equal(displayPath('/repo/src/app.ts', '/repo/'), 'src/app.ts')
  assert.equal(displayPath('/other/app.ts', '/repo'), '/other/app.ts')
})

/* ------------------------------------------------------------------ *
 * mapToolEnd
 * ------------------------------------------------------------------ */

test('a successful Bash run is subtitled with its first output line', () => {
  const started = mapToolStart('Bash', { command: 'npm test' }, CWD)
  const end = mapToolEnd(started, {
    isError: false,
    content: '',
    structured: { stdout: '\n\n> 42 passing\n> 0 failing\n', stderr: '', interrupted: false }
  })
  assert.equal(end.subtitle, '> 42 passing')
  assert.ok(end.detail?.startsWith('npm test'))
})

test('a long Bash output line is truncated to 120 characters', () => {
  const started = mapToolStart('Bash', { command: 'cat big.txt' }, CWD)
  const end = mapToolEnd(started, {
    isError: false,
    content: '',
    structured: { stdout: 'z'.repeat(500) }
  })
  assert.ok(end.subtitle)
  assert.equal(end.subtitle.length, 120)
})

test('a failed Bash run reports "failed" plus the first stderr line', () => {
  const started = mapToolStart('Bash', { command: 'npm test' }, CWD)
  const end = mapToolEnd(started, {
    isError: true,
    content: 'exit 1',
    structured: { stdout: '', stderr: 'Error: 3 tests failed\n  at foo.js:1' }
  })
  assert.equal(end.subtitle, 'failed — Error: 3 tests failed')
})

test('a failed Bash run with no stderr still says failed', () => {
  const started = mapToolStart('Bash', { command: 'false' }, CWD)
  const end = mapToolEnd(started, { isError: true, content: '', structured: { stderr: '' } })
  assert.equal(end.subtitle, 'failed')
})

test('edit line counts prefer the structured patch over the input estimate', () => {
  const started = mapToolStart(
    'Edit',
    { file_path: '/repo/src/app.ts', old_string: 'a\nb\nc\nd', new_string: 'a\nb' },
    CWD
  )
  assert.equal(started.subtitle, '+2 -4')

  const end = mapToolEnd(started, {
    isError: false,
    content: 'ok',
    structured: {
      structuredPatch: [{ lines: [' context', '-gone', '-gone2', '+added', ' more context'] }]
    }
  })
  assert.equal(end.addedLines, 1)
  assert.equal(end.removedLines, 2)
  assert.equal(end.subtitle, '+1 -2')
})

test('edit line counts fall back to the input estimate when no patch is returned', () => {
  const started = mapToolStart(
    'Edit',
    { file_path: '/repo/src/app.ts', old_string: 'x', new_string: 'y\nz' },
    CWD
  )
  const end = mapToolEnd(started, { isError: false, content: '', structured: null })
  assert.equal(end.addedLines, 2)
  assert.equal(end.removedLines, 1)
  assert.equal(end.subtitle, '+2 -1')
})

test('MultiEdit keeps its edit count alongside the line delta', () => {
  const started = mapToolStart(
    'MultiEdit',
    {
      file_path: '/repo/src/app.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd\ne' }
      ]
    },
    CWD
  )
  assert.equal(started.subtitle, '2 edits')
  const end = mapToolEnd(started, { isError: false, content: '', structured: null })
  assert.equal(end.subtitle, '2 edits · +3 -2')
})

test('Read reports how many lines came back', () => {
  const started = mapToolStart('Read', { file_path: '/repo/src/app.ts' }, CWD)
  const end = mapToolEnd(started, {
    isError: false,
    content: 'contents',
    structured: { file: { filePath: '/repo/src/app.ts', numLines: 214 } }
  })
  assert.equal(end.subtitle, '214 lines')
})

test('Grep keeps its scope and prepends the match count', () => {
  const started = mapToolStart('Grep', { pattern: 'useState', path: 'src' }, CWD)
  const end = mapToolEnd(started, {
    isError: false,
    content: 'src/a.ts:1: useState',
    structured: { mode: 'content', numLines: 12 }
  })
  assert.equal(end.subtitle, '12 matches in src')
})

test('a failing tool of any kind reports the reason', () => {
  const started = mapToolStart('Read', { file_path: '/repo/missing.ts' }, CWD)
  const end = mapToolEnd(started, {
    isError: true,
    content: 'File does not exist.',
    structured: null
  })
  assert.equal(end.subtitle, 'failed — File does not exist.')
})

test('detail combines the tool input with its output', () => {
  const started = mapToolStart('Bash', { command: 'echo hello' }, CWD)
  const end = mapToolEnd(started, { isError: false, content: 'hello', structured: null })
  assert.ok(end.detail?.includes('echo hello'))
  assert.ok(end.detail?.includes('hello'))
})

/* ------------------------------------------------------------------ *
 * summarizeActivities
 * ------------------------------------------------------------------ */

let seq = 0
function activity(patch: Partial<Activity>): Activity {
  seq += 1
  return {
    id: `act_${seq}`,
    messageId: 'msg_1',
    botId: 'bot_1',
    type: 'tool',
    title: 'Something',
    subtitle: null,
    detail: null,
    toolName: null,
    toolUseId: null,
    status: 'success',
    addedLines: null,
    removedLines: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    endedAt: '2026-08-23T00:00:01.000Z',
    seq,
    ...patch
  }
}

test('a finished turn collapses into readable transcript lines', () => {
  const lines = summarizeActivities([
    activity({ type: 'file_edit', title: 'src/a.ts' }),
    activity({ type: 'file_edit', title: 'src/b.ts' }),
    activity({ type: 'file_write', title: 'src/c.ts' }),
    activity({ type: 'command', title: 'npm test', status: 'success' }),
    activity({ type: 'file_read', title: 'src/a.ts' })
  ])
  assert.deepEqual(lines, ['Edited 3 files', 'Ran `npm test` — passed', 'Read src/a.ts'])
})

test('summaries follow the order the work actually happened in', () => {
  const lines = summarizeActivities([
    activity({ type: 'file_read', title: 'src/a.ts' }),
    activity({ type: 'command', title: 'npm run build', status: 'error' })
  ])
  assert.deepEqual(lines, ['Read src/a.ts', 'Ran `npm run build` — failed'])
})

test('a long run of commands collapses after the first few', () => {
  const lines = summarizeActivities([
    activity({ type: 'command', title: 'a' }),
    activity({ type: 'command', title: 'b' }),
    activity({ type: 'command', title: 'c' }),
    activity({ type: 'command', title: 'd' }),
    activity({ type: 'command', title: 'e' })
  ])
  assert.deepEqual(lines, [
    'Ran `a` — passed',
    'Ran `b` — passed',
    'Ran `c` — passed',
    'Ran 2 more commands'
  ])
})

test('searches, web calls, MCP calls and plans each get one line', () => {
  assert.deepEqual(summarizeActivities([activity({ type: 'search', title: 'useState' })]), [
    'Searched for useState'
  ])
  assert.deepEqual(
    summarizeActivities([
      activity({ type: 'search', title: 'a' }),
      activity({ type: 'search', title: 'b' })
    ]),
    ['Ran 2 searches']
  )
  assert.deepEqual(summarizeActivities([activity({ type: 'web', title: 'example.com' })]), [
    'Fetched example.com'
  ])
  assert.deepEqual(
    summarizeActivities([activity({ type: 'mcp', title: 'github / create_issue' })]),
    ['Called github / create_issue']
  )
  assert.deepEqual(summarizeActivities([activity({ type: 'todo', title: 'Updated plan' })]), [
    'Updated the plan'
  ])
})

test('thinking is not user-visible work and never appears in the summary', () => {
  assert.deepEqual(summarizeActivities([activity({ type: 'thinking', title: 'pondering' })]), [])
  assert.deepEqual(summarizeActivities([]), [])
})

/* ------------------------------------------------------------------ *
 * Against the real captured fixtures
 * ------------------------------------------------------------------ */

function toolPairsFromFixture(name: string): Array<{
  start: Extract<RuntimeEvent, { type: 'tool_start' }>
  end: Extract<RuntimeEvent, { type: 'tool_end' }>
}> {
  const ndjson = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const parser = new ClaudeStreamParser()
  const events = [...parser.push(ndjson), ...parser.flush()]

  const starts = new Map<string, Extract<RuntimeEvent, { type: 'tool_start' }>>()
  const pairs: Array<{
    start: Extract<RuntimeEvent, { type: 'tool_start' }>
    end: Extract<RuntimeEvent, { type: 'tool_end' }>
  }> = []
  for (const event of events) {
    if (event.type === 'tool_start') starts.set(event.toolUseId, event)
    if (event.type === 'tool_end') {
      const start = starts.get(event.toolUseId)
      if (start) pairs.push({ start, end: event })
    }
  }
  return pairs
}

test('fixture: the captured Bash call maps to a clean command card', () => {
  const [pair] = toolPairsFromFixture('stream-basic.ndjson')
  assert.ok(pair)

  const started = mapToolStart(pair.start.name, pair.start.input, '/Users/dev/Desktop/Repos')
  assert.equal(started.type, 'command')
  assert.equal(started.title, 'echo hello')
  assert.equal(started.subtitle, "Echo the string 'hello'")

  const finished = mapToolEnd(started, {
    isError: pair.end.isError,
    content: pair.end.content,
    structured: pair.end.structured
  })
  // structured.stdout from the real capture is exactly "hello".
  assert.equal(finished.subtitle, 'hello')
  assert.equal(finished.addedLines, null)
})

test('fixture: the captured MCP call maps to an mcp card with its text result', () => {
  const pairs = toolPairsFromFixture('stream-mcp.ndjson')
  assert.equal(pairs.length, 2)

  const search = pairs[0]!
  const searchCard = mapToolStart(search.start.name, search.start.input, '/repo')
  assert.equal(searchCard.type, 'tool')
  assert.equal(searchCard.title, 'Used ToolSearch')

  const ping = pairs[1]!
  const pingCard = mapToolStart(ping.start.name, ping.start.input, '/repo')
  assert.equal(pingCard.type, 'mcp')
  assert.equal(pingCard.title, 'echotest / ping_back')

  const finished = mapToolEnd(pingCard, {
    isError: ping.end.isError,
    content: ping.end.content,
    structured: ping.end.structured
  })
  assert.equal(finished.subtitle, 'PONGMCP:x')
})

test('fixture: every captured tool call yields a JSON-free single-line title', () => {
  for (const name of ['stream-basic.ndjson', 'stream-mcp.ndjson']) {
    for (const pair of toolPairsFromFixture(name)) {
      const card = mapToolStart(pair.start.name, pair.start.input, '/repo')
      assert.ok(card.title.length > 0)
      assert.ok(!card.title.includes('\n'))
      assert.ok(!card.title.includes('":'), `${pair.start.name} leaked JSON`)
      assert.equal(card.toolName, pair.start.name)
    }
  }
})
