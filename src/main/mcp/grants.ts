/**
 * The control server's credential registry.
 *
 * Split out of `controlServer.ts` for two reasons: it is the whole authentication
 * path in one place, and it depends on nothing but `node:crypto`, so it can be
 * exercised directly by `test/mcp-grants.test.ts` instead of only through a live
 * HTTP server.
 *
 * The token IS the caller's identity. A grant maps a 32-byte bearer token to the
 * `{ botId, conversationId }` every request presenting it acts as; the request
 * body may never state an identity of its own.
 *
 * Lifetimes:
 *   - `issueGrant()` mints one credential. `ClaudeCodeRuntime` writes the document
 *     carrying it to a 0600 file for exactly one CLI process and retires it when
 *     that process is reaped, so a token read out of the file dies with the turn.
 *   - `retireGrant()` kills the credential but keeps its IDENTITY for a little
 *     while, because one job can run more than one attempt: PRD §37 session
 *     recovery re-runs the same turn with the same input, and the attempt that
 *     failed has already retired the credential the recovered attempt was going
 *     to present. Without the retained identity there is nothing left to re-issue
 *     against and every handoff in a recovered turn answered 401.
 *
 * A retired entry holds no secret: it is keyed by the SHA-256 of a token that no
 * longer authenticates, and its value is a pair of app-internal ids.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface GrantIdentity {
  botId: string
  conversationId: string
}

/**
 * One issued credential. `botId`/`conversationId` are the identity every call
 * presenting this token acts under — they are never read from the request.
 */
export interface JobGrant extends GrantIdentity {
  token: string
  issuedAt: number
}

/**
 * Live grants, keyed by SHA-256 of the token so the map lookup never touches the
 * secret itself. Module-level rather than inside the server state so a hot-reload
 * re-bootstrap (which reuses the listening server) does not strand live turns.
 */
const grants = new Map<string, JobGrant>()

/** Identities of retired credentials, same keying. Never authenticates anything. */
const retired = new Map<string, GrantIdentity>()

/**
 * Backstop for a grant whose retire never ran (a crashed turn, an app killed
 * mid-run). Long enough that no real turn can outlive it; short enough that a
 * leak is bounded. Swept lazily when the next grant is minted.
 */
const GRANT_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Retired identities are bounded by count rather than by age, deliberately: a
 * first attempt can run for many minutes before it fails, and its retry must
 * still find its identity however long that took. Bounding by count is safe
 * because a retry follows its own attempt immediately — hundreds of other turns
 * cannot slip in between.
 */
const RETIRED_MAX_ENTRIES = 256

function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Mint a credential for one turn and record it against that turn's identity. */
export function issueGrant(identity: GrantIdentity): JobGrant {
  sweepExpiredGrants()
  const grant: JobGrant = {
    token: randomBytes(32).toString('hex'),
    botId: identity.botId,
    conversationId: identity.conversationId,
    issuedAt: Date.now()
  }
  grants.set(tokenKey(grant.token), grant)
  return grant
}

/**
 * Resolve a bearer header to the grant it was issued as, or null.
 *
 * The map is keyed by a SHA-256 of the token, so the lookup itself compares a
 * digest rather than the secret. The stored token is then compared in constant
 * time as well: length is leaked (both sides are fixed-width hex), the bytes are
 * not. Retired credentials are not in this map at all, so a spent token cannot
 * authenticate even by accident.
 */
export function resolveGrant(header: string | undefined): JobGrant | null {
  if (!header) return null
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return null
  const presentedText = header.slice(prefix.length)
  if (!presentedText) return null

  const grant = grants.get(tokenKey(presentedText))
  if (!grant) return null

  const presented = Buffer.from(presentedText, 'utf8')
  const wanted = Buffer.from(grant.token, 'utf8')
  if (presented.byteLength !== wanted.byteLength) return null
  return timingSafeEqual(presented, wanted) ? grant : null
}

/** True while this token still authenticates. */
export function isLiveGrant(token: string): boolean {
  return grants.has(tokenKey(token))
}

/**
 * Kill a credential, keeping its identity so the same turn can be re-credentialled
 * if it has to be retried. Safe to call twice.
 */
export function retireGrant(token: string): void {
  const key = tokenKey(token)
  const grant = grants.get(key)
  if (grant) {
    grants.delete(key)
    remember(key, { botId: grant.botId, conversationId: grant.conversationId })
  }
}

/** The identity behind a token, live or retired. Null once it has been forgotten. */
export function identityForToken(token: string): GrantIdentity | null {
  const key = tokenKey(token)
  const grant = grants.get(key)
  if (grant) return { botId: grant.botId, conversationId: grant.conversationId }
  const previous = retired.get(key)
  return previous ? { ...previous } : null
}

/** Every outstanding credential dies with the listener. */
export function clearGrants(): void {
  grants.clear()
  retired.clear()
}

/** Exposed for tests and diagnostics; never for authorization decisions. */
export function grantCounts(): { live: number; retired: number } {
  return { live: grants.size, retired: retired.size }
}

function remember(key: string, identity: GrantIdentity): void {
  // Re-insert so the most recently retired entry is always the youngest in
  // insertion order, which is what the eviction below relies on.
  retired.delete(key)
  retired.set(key, identity)
  while (retired.size > RETIRED_MAX_ENTRIES) {
    const oldest = retired.keys().next()
    if (oldest.done) break
    retired.delete(oldest.value)
  }
}

/** Bounds the damage from a turn whose retire never ran (crash, hard kill). */
function sweepExpiredGrants(): void {
  const cutoff = Date.now() - GRANT_MAX_AGE_MS
  for (const [key, grant] of grants) {
    if (grant.issuedAt < cutoff) grants.delete(key)
  }
}
