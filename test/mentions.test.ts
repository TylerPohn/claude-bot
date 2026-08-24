import test from 'node:test'
import assert from 'node:assert/strict'
// Node's type stripper needs the real file extension; `allowImportingTsExtensions`
// is off in the shared tsconfig, so the import specifier is silenced for tsc only.
// @ts-ignore TS5097
import { parseMentions, segmentMentions } from '../src/main/orchestration/mentions.ts'
import type { Bot, MessageMention } from '@shared/types'

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    title: null,
    description: '',
    avatarType: 'emoji',
    avatarValue: '🤖',
    accent: 'violet',
    defaultWorkingDirectory: null,
    model: 'default',
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    pinned: false,
    hidden: false,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const BUILDER = bot('bot_builder', 'Builder')
const PM = bot('bot_pm', 'Product Manager')
const PRODUCT = bot('bot_product', 'Product')
const ROSTER = [BUILDER, PM, PRODUCT]

test('parses a single mention and spans the whole @Name', () => {
  const text = '@Builder ship the login screen'
  const [mention, ...rest] = parseMentions(text, ROSTER)
  assert.equal(rest.length, 0)
  assert.equal(mention!.botId, 'bot_builder')
  assert.equal(mention!.everyone, false)
  assert.equal(mention!.display, '@Builder')
  assert.equal(mention!.startIndex, 0)
  assert.equal(mention!.endIndex, 8)
  assert.equal(text.slice(mention!.startIndex, mention!.endIndex), '@Builder')
})

test('matches the longest member name when names overlap', () => {
  const mentions = parseMentions('@Product Manager please scope this', ROSTER)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.botId, 'bot_pm')
  assert.equal(mentions[0]!.display, '@Product Manager')
  assert.equal(mentions[0]!.endIndex, '@Product Manager'.length)
})

test('falls back to the shorter name when the longer one does not follow', () => {
  const mentions = parseMentions('@Product what is the roadmap?', ROSTER)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.botId, 'bot_product')
})

test('trailing punctuation is not swallowed into the name', () => {
  for (const punctuation of ['.', ',', '!', '?', ':', ';', ')']) {
    const text = `hey @Builder${punctuation} take a look`
    const mentions = parseMentions(text, ROSTER)
    assert.equal(mentions.length, 1, `punctuation ${punctuation}`)
    assert.equal(mentions[0]!.botId, 'bot_builder')
    assert.equal(text.slice(mentions[0]!.startIndex, mentions[0]!.endIndex), '@Builder')
  }
})

test('a mention at end of input still resolves', () => {
  const mentions = parseMentions('over to you @Builder', ROSTER)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.endIndex, 'over to you @Builder'.length)
})

test('matching is case-insensitive but display is canonical', () => {
  const mentions = parseMentions('@buILDer and @PRODUCT MANAGER', ROSTER)
  assert.deepEqual(
    mentions.map((m) => [m.botId, m.display]),
    [
      ['bot_builder', '@Builder'],
      ['bot_pm', '@Product Manager']
    ]
  )
  // Canonical display must still cover exactly the typed span, so the renderer can
  // substitute one for the other without shifting any other mention's indices.
  const text = '@buILDer and @PRODUCT MANAGER'
  for (const mention of mentions) {
    assert.equal(mention.endIndex - mention.startIndex, mention.display.length)
  }
  assert.equal(text.slice(mentions[1]!.startIndex, mentions[1]!.endIndex).toLowerCase(), '@product manager')
})

test('@everyone and @all produce broadcast mentions', () => {
  for (const alias of ['@everyone', '@all', '@EVERYONE']) {
    const mentions = parseMentions(`${alias} status check`, ROSTER)
    assert.equal(mentions.length, 1, alias)
    assert.equal(mentions[0]!.everyone, true)
    assert.equal(mentions[0]!.botId, null)
  }
})

/**
 * Regression: a Bot named "everyone" used to be added to the candidate set before
 * the broadcast aliases, so it swallowed "@everyone" — the message routed to that
 * one Bot, `everyone` stayed false, and the "Run N Bots?" confirmation sheet never
 * appeared for a fan-out the user thought they had performed.
 */
test('a Bot named everyone or all cannot swallow the broadcast alias', () => {
  for (const name of ['everyone', 'All', 'EVERYONE']) {
    const roster = [bot('bot_impostor', name), BUILDER]
    const mentions = parseMentions(`@${name} ship it`, roster)
    assert.equal(mentions.length, 1, name)
    assert.equal(mentions[0]!.everyone, true, name)
    assert.equal(mentions[0]!.botId, null, name)
    assert.equal(mentions[0]!.display, `@${name.toLowerCase()}`, name)
    // The span still covers exactly the text that was typed.
    assert.equal(mentions[0]!.endIndex - mentions[0]!.startIndex, name.length + 1, name)
  }
  // Every other member of that roster still parses normally.
  const roster = [bot('bot_impostor', 'everyone'), BUILDER]
  assert.deepEqual(
    parseMentions('@Builder and @everyone', roster).map((m) => m.display),
    ['@Builder', '@everyone']
  )
})

test('an unknown @name produces no mention', () => {
  assert.deepEqual(parseMentions('@Nobody are you there', ROSTER), [])
  assert.deepEqual(parseMentions('@ Builder', ROSTER), [])
  assert.deepEqual(parseMentions('email me at sam@example.com', ROSTER), [])
})

test('a prefix of a member name does not match mid-word', () => {
  assert.deepEqual(parseMentions('@Builders are great', ROSTER), [])
})

test('multiple mentions in one message keep their order and spans', () => {
  const text = '@Builder implement it, then @Product Manager sign off. @everyone fyi'
  const mentions = parseMentions(text, ROSTER)
  assert.deepEqual(
    mentions.map((m) => m.display),
    ['@Builder', '@Product Manager', '@everyone']
  )
  for (const mention of mentions) {
    assert.equal(text.slice(mention.startIndex, mention.endIndex).length, mention.display.length)
  }
})

test('empty roster still recognises the broadcast aliases only', () => {
  assert.equal(parseMentions('@everyone hi', []).length, 1)
  assert.equal(parseMentions('@Builder hi', []).length, 0)
})

test('segmentMentions renders the stored display, not the current roster', () => {
  const text = '@Builder ship it'
  const stored: MessageMention[] = [
    { botId: 'bot_builder', display: '@Builder', everyone: false, startIndex: 0, endIndex: 8 }
  ]
  // The bot has since been renamed to "Constructor"; the old message must not change.
  const segments = segmentMentions(text, stored)
  assert.deepEqual(segments, [
    { type: 'mention', text: '@Builder', botId: 'bot_builder', everyone: false },
    { type: 'text', text: ' ship it' }
  ])
})

test('segmentMentions splits text around several mentions', () => {
  const text = 'hey @Builder and @everyone!'
  const segments = segmentMentions(text, parseMentions(text, ROSTER))
  assert.deepEqual(segments, [
    { type: 'text', text: 'hey ' },
    { type: 'mention', text: '@Builder', botId: 'bot_builder', everyone: false },
    { type: 'text', text: ' and ' },
    { type: 'mention', text: '@everyone', botId: null, everyone: true },
    { type: 'text', text: '!' }
  ])
})

test('segmentMentions ignores stale or overlapping spans instead of throwing', () => {
  const text = 'short'
  const segments = segmentMentions(text, [
    { botId: 'a', display: '@A', everyone: false, startIndex: 0, endIndex: 2 },
    { botId: 'b', display: '@B', everyone: false, startIndex: 1, endIndex: 3 },
    { botId: 'c', display: '@C', everyone: false, startIndex: 400, endIndex: 402 }
  ])
  assert.deepEqual(segments, [
    { type: 'mention', text: '@A', botId: 'a', everyone: false },
    { type: 'text', text: 'ort' }
  ])
})

test('segmentMentions with no mentions returns the whole body as one text run', () => {
  assert.deepEqual(segmentMentions('plain text', []), [{ type: 'text', text: 'plain text' }])
  assert.deepEqual(segmentMentions('', []), [])
})

/* ------------------------------------------------------------------ *
 * Length-changing lowercase (regression)
 *
 * `parseMentions` used to scan `text.toLowerCase()` with offsets found in
 * `text`. 'İ' (U+0130) is the one code point whose lowercase form is LONGER
 * than the original, so a single one of them shifted every later index and
 * could drop an @mention entirely — a silent misroute, because an empty
 * mention list sends `MentionRouter` down the auto path.
 * ------------------------------------------------------------------ */

const ATLAS = bot('bot_atlas', 'Atlas')
const IVAN = bot('bot_ivan', 'İvan')
const TURKISH = [BUILDER, ATLAS, IVAN]

test('a length-growing character before the @ does not hide the mention', () => {
  const text = 'İstanbul standup @Builder'
  const mentions = parseMentions(text, TURKISH)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.botId, 'bot_builder')
  assert.equal(mentions[0]!.startIndex, 17)
  assert.equal(mentions[0]!.endIndex, 25)
  assert.equal(text.slice(mentions[0]!.startIndex, mentions[0]!.endIndex), '@Builder')
})

test('several length-growing characters still leave the span exact', () => {
  const text = 'İİ @Atlas ping'
  const mentions = parseMentions(text, TURKISH)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.botId, 'bot_atlas')
  assert.equal(text.slice(mentions[0]!.startIndex, mentions[0]!.endIndex), '@Atlas')
})

test('a bot name containing İ spans exactly its own name', () => {
  const text = 'hey @İvan ping'
  const mentions = parseMentions(text, TURKISH)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0]!.botId, 'bot_ivan')
  // The bug returned [4, 10), which sliced "@İvan " — one character too long.
  assert.equal(text.slice(mentions[0]!.startIndex, mentions[0]!.endIndex), '@İvan')
  assert.equal(mentions[0]!.endIndex - mentions[0]!.startIndex, mentions[0]!.display.length)
})

test('a mention after an İ-named mention is still found', () => {
  const text = '@İvan @Atlas ping'
  const mentions = parseMentions(text, TURKISH)
  assert.deepEqual(
    mentions.map((m) => m.botId),
    ['bot_ivan', 'bot_atlas']
  )
  for (const mention of mentions) {
    assert.equal(text.slice(mention.startIndex, mention.endIndex), mention.display)
  }
  // The space between the two chips must survive rendering.
  assert.deepEqual(segmentMentions(text, mentions), [
    { type: 'mention', text: '@İvan', botId: 'bot_ivan', everyone: false },
    { type: 'text', text: ' ' },
    { type: 'mention', text: '@Atlas', botId: 'bot_atlas', everyone: false },
    { type: 'text', text: ' ping' }
  ])
})

test('@everyone followed by an İ does not swallow the next mention', () => {
  const text = '@everyone İ @Atlas'
  const mentions = parseMentions(text, TURKISH)
  assert.deepEqual(
    mentions.map((m) => m.display),
    ['@everyone', '@Atlas']
  )
  assert.equal(text.slice(mentions[1]!.startIndex, mentions[1]!.endIndex), '@Atlas')
})
