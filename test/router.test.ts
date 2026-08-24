import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 — see the note in test/mentions.test.ts
import { routeMessage } from '../src/main/orchestration/MentionRouter.ts'
// @ts-ignore TS5097
import { parseMentions } from '../src/main/orchestration/mentions.ts'
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
const REVIEWER = bot('bot_reviewer', 'Reviewer')
const RESEARCHER = bot('bot_researcher', 'Researcher')
const GROUP = [BUILDER, REVIEWER, RESEARCHER]

function route(
  overrides: Partial<Parameters<typeof routeMessage>[0]> & { mentions?: MessageMention[] } = {}
): ReturnType<typeof routeMessage> {
  return routeMessage({
    conversationType: 'group',
    members: GROUP,
    mentions: [],
    routing: { mode: 'auto' },
    defaultResponderBotId: null,
    busyBotIds: [],
    ...overrides
  })
}

test('direct chat always routes to its single member', () => {
  const result = routeMessage({
    conversationType: 'direct',
    members: [BUILDER],
    mentions: parseMentions('@Reviewer look at this', GROUP),
    routing: { mode: 'everyone' },
    defaultResponderBotId: 'bot_reviewer',
    busyBotIds: ['bot_builder']
  })
  // A 1:1 ignores mentions for ROUTING (PRD §11.1) but still reports that the Bot
  // the user actually addressed is not in this conversation and will never see it.
  assert.deepEqual(result, {
    botIds: ['bot_builder'],
    reason: 'direct',
    everyone: false,
    unreachableBotIds: ['bot_reviewer']
  })
})

test('@everyone beats an explicit bot mention and the routing selector', () => {
  const result = route({
    mentions: parseMentions('@Builder @everyone standup', GROUP),
    routing: { mode: 'bot', botId: 'bot_reviewer' }
  })
  assert.deepEqual(result, {
    botIds: ['bot_builder', 'bot_reviewer', 'bot_researcher'],
    reason: 'everyone',
    everyone: true,
    unreachableBotIds: []
  })
})

test('explicit mentions invoke exactly those bots, deduped, in membership order', () => {
  const result = route({
    mentions: parseMentions('@Researcher @Builder @Researcher go', GROUP),
    defaultResponderBotId: 'bot_reviewer'
  })
  assert.deepEqual(result, {
    botIds: ['bot_builder', 'bot_researcher'],
    reason: 'explicit-mentions',
    everyone: false,
    unreachableBotIds: []
  })
})

test('a mention of a bot that has left the group is ignored but reported', () => {
  const result = route({
    mentions: [
      { botId: 'bot_gone', display: '@Gone', everyone: false, startIndex: 0, endIndex: 5 }
    ],
    defaultResponderBotId: 'bot_reviewer'
  })
  assert.equal(result.reason, 'default-responder')
  assert.deepEqual(result.botIds, ['bot_reviewer'])
  // Routing is unchanged; the caller gets told so it can say who was missed.
  assert.deepEqual(result.unreachableBotIds, ['bot_gone'])
})

test('unreachable mentions are deduped, ordered by the message, and reported alongside a valid mention', () => {
  const result = route({
    mentions: [
      { botId: 'bot_gone', display: '@Gone', everyone: false, startIndex: 0, endIndex: 5 },
      { botId: 'bot_builder', display: '@Builder', everyone: false, startIndex: 6, endIndex: 14 },
      { botId: 'bot_ghost', display: '@Ghost', everyone: false, startIndex: 15, endIndex: 21 },
      { botId: 'bot_gone', display: '@Gone', everyone: false, startIndex: 22, endIndex: 27 }
    ]
  })
  assert.equal(result.reason, 'explicit-mentions')
  assert.deepEqual(result.botIds, ['bot_builder'])
  assert.deepEqual(result.unreachableBotIds, ['bot_gone', 'bot_ghost'])
})

test('@everyone still reports a named non-member', () => {
  const result = route({
    mentions: [
      { botId: null, display: '@everyone', everyone: true, startIndex: 0, endIndex: 9 },
      { botId: 'bot_gone', display: '@Gone', everyone: false, startIndex: 10, endIndex: 15 }
    ]
  })
  assert.equal(result.reason, 'everyone')
  assert.deepEqual(result.unreachableBotIds, ['bot_gone'])
})

test('routing override to one bot wins when nothing is mentioned', () => {
  const result = route({
    routing: { mode: 'bot', botId: 'bot_researcher' },
    defaultResponderBotId: 'bot_builder'
  })
  assert.deepEqual(result, {
    botIds: ['bot_researcher'],
    reason: 'routing-override',
    everyone: false,
    unreachableBotIds: []
  })
})

test('routing override to everyone fans out and flags the confirm', () => {
  const result = route({ routing: { mode: 'everyone' } })
  assert.equal(result.reason, 'routing-override')
  assert.equal(result.everyone, true)
  assert.deepEqual(result.botIds, ['bot_builder', 'bot_reviewer', 'bot_researcher'])
})

test('a routing override naming a non-member falls through to auto', () => {
  const result = route({ routing: { mode: 'bot', botId: 'bot_gone' } })
  assert.equal(result.reason, 'first-member')
  assert.deepEqual(result.botIds, ['bot_builder'])
})

test('auto uses the group default responder', () => {
  const result = route({ defaultResponderBotId: 'bot_reviewer', busyBotIds: ['bot_reviewer'] })
  assert.deepEqual(result, {
    botIds: ['bot_reviewer'],
    reason: 'default-responder',
    everyone: false,
    unreachableBotIds: []
  })
})

test('a default responder that is no longer a member is skipped', () => {
  const result = route({ defaultResponderBotId: 'bot_gone' })
  assert.equal(result.reason, 'first-member')
})

test('auto picks the only idle bot when every other member is busy', () => {
  const result = route({ busyBotIds: ['bot_builder', 'bot_reviewer'] })
  assert.deepEqual(result, {
    botIds: ['bot_researcher'],
    reason: 'idle-fallback',
    everyone: false,
    unreachableBotIds: []
  })
})

test('two idle bots is not an idle-fallback', () => {
  const result = route({ busyBotIds: ['bot_builder'] })
  assert.equal(result.reason, 'first-member')
  assert.deepEqual(result.botIds, ['bot_builder'])
})

test('all bots busy falls back to the first member rather than nobody', () => {
  const result = route({ busyBotIds: ['bot_builder', 'bot_reviewer', 'bot_researcher'] })
  assert.equal(result.reason, 'first-member')
  assert.deepEqual(result.botIds, ['bot_builder'])
})

test('a single-member group never reports idle-fallback', () => {
  const result = routeMessage({
    conversationType: 'group',
    members: [REVIEWER],
    mentions: [],
    routing: { mode: 'auto' },
    defaultResponderBotId: null,
    busyBotIds: []
  })
  assert.deepEqual(result, {
    botIds: ['bot_reviewer'],
    reason: 'first-member',
    everyone: false,
    unreachableBotIds: []
  })
})

test('an empty group routes to nobody without throwing', () => {
  const result = routeMessage({
    conversationType: 'group',
    members: [],
    mentions: [],
    routing: { mode: 'auto' },
    defaultResponderBotId: 'bot_builder',
    busyBotIds: []
  })
  assert.deepEqual(result, {
    botIds: [],
    reason: 'first-member',
    everyone: false,
    unreachableBotIds: []
  })
})

test('an empty direct conversation routes to nobody', () => {
  const result = routeMessage({
    conversationType: 'direct',
    members: [],
    mentions: [],
    routing: { mode: 'auto' },
    defaultResponderBotId: null,
    busyBotIds: []
  })
  assert.deepEqual(result.botIds, [])
})
