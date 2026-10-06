import { createHash, randomBytes } from 'node:crypto'

/** Env var the claude process gets; `.claude.json` references it as `${CLAUDEDECK_MCP_TOKEN}`. */
export const MCP_TOKEN_ENV = 'CLAUDEDECK_MCP_TOKEN'

/** What one Claude tab may touch through the MCP server. */
export interface McpScope {
  sessionId: string
  projectId: string
  accountId: string
}

export interface SessionTokens {
  /** Issues a fresh token for a session, invalidating that session's previous one. */
  issue(scope: McpScope): string
  revoke(sessionId: string): void
  revokeAll(): void
  lookup(token: string): McpScope | null
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

// Keys are hashes of the tokens, so a lookup's timing depends on the hash of the attacker's
// input rather than on how many leading characters of a real token it matches.
const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

/** In-memory only: tokens die with the app and are never written to disk. */
export function createSessionTokens(): SessionTokens {
  const scopes = new Map<string, McpScope>()
  const bySession = new Map<string, string>()

  const revoke = (sessionId: string): void => {
    const key = bySession.get(sessionId)
    if (key === undefined) return
    scopes.delete(key)
    bySession.delete(sessionId)
  }

  return {
    issue(scope) {
      revoke(scope.sessionId)
      const token = randomBytes(32).toString('hex')
      const key = digest(token)
      scopes.set(key, Object.freeze({ ...scope }))
      bySession.set(scope.sessionId, key)
      return token
    },
    revoke,
    revokeAll() {
      scopes.clear()
      bySession.clear()
    },
    lookup(token) {
      if (!TOKEN_PATTERN.test(token)) return null
      return scopes.get(digest(token)) ?? null
    }
  }
}
