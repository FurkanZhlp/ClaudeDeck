import { describe, expect, it } from 'vitest'
import { createSessionTokens, MCP_TOKEN_ENV } from './sessionTokens'

const scope = { sessionId: 's1', projectId: 'p1', accountId: 'a1' }

describe('session tokens', () => {
  it('issues random hex tokens that resolve to their scope', () => {
    const tokens = createSessionTokens()
    const token = tokens.issue(scope)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens.lookup(token)).toEqual(scope)
    expect(tokens.issue({ ...scope, sessionId: 's2' })).not.toBe(token)
    expect(MCP_TOKEN_ENV).toBe('CLAUDEDECK_MCP_TOKEN')
  })

  it('rejects unknown and malformed tokens', () => {
    const tokens = createSessionTokens()
    tokens.issue(scope)
    expect(tokens.lookup('0'.repeat(64))).toBeNull()
    expect(tokens.lookup('nope')).toBeNull()
    expect(tokens.lookup('')).toBeNull()
  })

  it('replaces the previous token of a session on reissue', () => {
    const tokens = createSessionTokens()
    const first = tokens.issue(scope)
    const second = tokens.issue({ ...scope, projectId: 'p2' })
    expect(tokens.lookup(first)).toBeNull()
    expect(tokens.lookup(second)).toEqual({ ...scope, projectId: 'p2' })
  })

  it('revokes one session or all of them', () => {
    const tokens = createSessionTokens()
    const a = tokens.issue(scope)
    const b = tokens.issue({ ...scope, sessionId: 's2' })
    tokens.revoke('s1')
    tokens.revoke('unknown')
    expect(tokens.lookup(a)).toBeNull()
    expect(tokens.lookup(b)).not.toBeNull()
    tokens.revokeAll()
    expect(tokens.lookup(b)).toBeNull()
  })

  it('does not let callers mutate a stored scope', () => {
    const tokens = createSessionTokens()
    const input = { ...scope }
    const token = tokens.issue(input)
    input.projectId = 'other'
    const found = tokens.lookup(token)
    expect(found?.projectId).toBe('p1')
    expect(Object.isFrozen(found)).toBe(true)
  })
})
