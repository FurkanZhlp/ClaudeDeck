import { describe, expect, it } from 'vitest'
import { createSessionTokens, MCP_TOKEN_ENV, scopeId, type OptimizeScope } from './sessionTokens'

const scope = { sessionId: 's1', projectId: 'p1', accountId: 'a1' }
const session = { kind: 'session' as const, ...scope }
const run: OptimizeScope = { kind: 'optimize', runId: 'r1', accountId: 'a1' }

describe('session tokens', () => {
  it('issues random hex tokens that resolve to their scope', () => {
    const tokens = createSessionTokens()
    const token = tokens.issue(scope)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens.lookup(token)).toEqual(session)
    expect(tokens.issue({ ...scope, sessionId: 's2' })).not.toBe(token)
    expect(MCP_TOKEN_ENV).toBe('CLAUDEDECK_MCP_TOKEN')
  })

  it('accepts explicit session and optimize scopes', () => {
    const tokens = createSessionTokens()
    expect(tokens.lookup(tokens.issue(session))).toEqual(session)
    expect(tokens.lookup(tokens.issue(run))).toEqual(run)
    expect(scopeId(run)).toBe('r1')
    expect(scopeId(session)).toBe('s1')
  })

  it('drops unknown fields from a scope', () => {
    const tokens = createSessionTokens()
    const extra = { ...run, sessionId: 'sneaky', projectId: 'p9' } as OptimizeScope
    expect(tokens.lookup(tokens.issue(extra))).toEqual(run)
  })

  it('rejects unknown and malformed tokens', () => {
    const tokens = createSessionTokens()
    tokens.issue(scope)
    expect(tokens.lookup('0'.repeat(64))).toBeNull()
    expect(tokens.lookup('nope')).toBeNull()
    expect(tokens.lookup('')).toBeNull()
  })

  it('replaces the previous token of a session or run on reissue', () => {
    const tokens = createSessionTokens()
    const first = tokens.issue(scope)
    const second = tokens.issue({ ...scope, projectId: 'p2' })
    expect(tokens.lookup(first)).toBeNull()
    expect(tokens.lookup(second)).toEqual({ ...session, projectId: 'p2' })
    const r1 = tokens.issue(run)
    const r2 = tokens.issue(run)
    expect(tokens.lookup(r1)).toBeNull()
    expect(tokens.lookup(r2)).toEqual(run)
  })

  it('revokes by session id or run id, or all of them', () => {
    const tokens = createSessionTokens()
    const a = tokens.issue(scope)
    const b = tokens.issue({ ...scope, sessionId: 's2' })
    const r = tokens.issue(run)
    tokens.revoke('s1')
    tokens.revoke('unknown')
    expect(tokens.lookup(a)).toBeNull()
    expect(tokens.lookup(b)).not.toBeNull()
    tokens.revoke('r1')
    expect(tokens.lookup(r)).toBeNull()
    tokens.revokeAll()
    expect(tokens.lookup(b)).toBeNull()
  })

  it('revokes only one scope kind when asked', () => {
    const tokens = createSessionTokens()
    const tab = tokens.issue(scope)
    const r = tokens.issue(run)
    tokens.revokeAll('session')
    expect(tokens.lookup(tab)).toBeNull()
    expect(tokens.lookup(r)).toEqual(run)
    // The owner index was cleaned too: reissuing works and revoke by id still applies.
    const again = tokens.issue(scope)
    tokens.revoke('s1')
    expect(tokens.lookup(again)).toBeNull()
  })

  it('does not let callers mutate a stored scope', () => {
    const tokens = createSessionTokens()
    const input = { ...scope }
    const token = tokens.issue(input)
    input.projectId = 'other'
    const found = tokens.lookup(token)
    expect(found?.kind === 'session' && found.projectId).toBe('p1')
    expect(Object.isFrozen(found)).toBe(true)
  })
})
