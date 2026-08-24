/**
 * Control-server credential lifecycle.
 *
 * The bar these enforce is the one the handoff bridge depends on: a token
 * authenticates for exactly one attempt, a retired token authenticates for
 * nothing, and a turn that has to be RETRIED can still be re-credentialled.
 *
 * That last one is a real defect this file exists to prevent coming back. One
 * `--mcp-config` document is minted per job, but it is revoked per attempt, so
 * when session recovery (PRD §37) re-ran a turn with the same input the token in
 * it had already been deleted and every handoff answered 401 Unauthorized.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 — see the note in test/mentions.test.ts
import {
  clearGrants,
  grantCounts,
  identityForToken,
  isLiveGrant,
  issueGrant,
  resolveGrant,
  retireGrant
} from '../src/main/mcp/grants.ts'

const IDENTITY = { botId: 'bot_builder', conversationId: 'conv_1' }

function bearer(token: string): string {
  return `Bearer ${token}`
}

test.beforeEach(() => clearGrants())

test('an issued token resolves to the identity it was issued for', () => {
  const grant = issueGrant(IDENTITY)
  const resolved = resolveGrant(bearer(grant.token))
  assert.equal(resolved?.botId, 'bot_builder')
  assert.equal(resolved?.conversationId, 'conv_1')
})

test('every grant gets its own 32-byte token', () => {
  const a = issueGrant(IDENTITY)
  const b = issueGrant(IDENTITY)
  assert.notEqual(a.token, b.token)
  // 32 random bytes, hex encoded.
  assert.match(a.token, /^[0-9a-f]{64}$/)
})

test('a malformed, missing or unknown authorization header resolves to nothing', () => {
  const grant = issueGrant(IDENTITY)
  assert.equal(resolveGrant(undefined), null)
  assert.equal(resolveGrant(''), null)
  assert.equal(resolveGrant('Bearer'), null)
  assert.equal(resolveGrant('Bearer '), null)
  // The scheme matters: the header is compared, not searched.
  assert.equal(resolveGrant(grant.token), null)
  assert.equal(resolveGrant(`Basic ${grant.token}`), null)
  assert.equal(resolveGrant(bearer(`${grant.token}x`)), null)
  assert.equal(resolveGrant(bearer(grant.token.slice(0, -1))), null)
})

test('a retired token stops authenticating immediately', () => {
  const grant = issueGrant(IDENTITY)
  retireGrant(grant.token)
  assert.equal(resolveGrant(bearer(grant.token)), null)
  assert.equal(isLiveGrant(grant.token), false)
  // Retiring twice is safe: the runtime's `finally` can run on paths that
  // already unwound once.
  retireGrant(grant.token)
  assert.equal(resolveGrant(bearer(grant.token)), null)
})

test('a retired token still names its identity, so a retried turn can be re-issued', () => {
  const first = issueGrant(IDENTITY)
  // The failed attempt's `finally` revokes the credential…
  retireGrant(first.token)
  // …and the retry, which carries the SAME document, must still be placeable.
  const identity = identityForToken(first.token)
  assert.deepEqual(identity, IDENTITY)

  const second = issueGrant(identity as typeof IDENTITY)
  assert.notEqual(second.token, first.token)
  assert.equal(resolveGrant(bearer(second.token))?.botId, 'bot_builder')
  // The dead one is still dead — re-issuing does not resurrect it.
  assert.equal(resolveGrant(bearer(first.token)), null)
})

test('an identity is forgotten once far more turns have run than any retry could span', () => {
  const first = issueGrant(IDENTITY)
  retireGrant(first.token)
  for (let i = 0; i < 300; i++) {
    retireGrant(issueGrant({ botId: `bot_${i}`, conversationId: 'conv_1' }).token)
  }
  assert.equal(identityForToken(first.token), null)
  // Bounded, not unbounded: the registry does not grow with uptime.
  assert.ok(grantCounts().retired <= 256)
})

test('clearGrants drops live and retired credentials alike', () => {
  const live = issueGrant(IDENTITY)
  const dead = issueGrant(IDENTITY)
  retireGrant(dead.token)

  clearGrants()

  assert.equal(resolveGrant(bearer(live.token)), null)
  assert.equal(identityForToken(dead.token), null)
  assert.deepEqual(grantCounts(), { live: 0, retired: 0 })
})
