import { createHash, randomBytes } from 'node:crypto'

/** Env var the claude process gets; `.claude.json` references it as `${CLAUDEDECK_MCP_TOKEN}`. */
export const MCP_TOKEN_ENV = 'CLAUDEDECK_MCP_TOKEN'

/** What one Claude tab may touch through the MCP server. */
export interface SessionScope {
  kind: 'session'
  sessionId: string
  projectId: string
  accountId: string
}

/** A headless profile optimization run; it only reaches the optimize tools. */
export interface OptimizeScope {
  kind: 'optimize'
  runId: string
  accountId: string
}

/** A headless "edit settings with Claude" run; it only reaches the settings assistant tools. */
export interface AssistantScope {
  kind: 'assistant'
  runId: string
  accountId: string
}

export type McpScope = SessionScope | OptimizeScope | AssistantScope
export type McpScopeKind = McpScope['kind']

/** Session scopes may omit `kind` so older callers keep working. */
export type McpScopeInput = McpScope | Omit<SessionScope, 'kind'>

export interface SessionTokens {
  /** Issues a fresh token for a session or run, invalidating that owner's previous one. */
  issue(scope: McpScopeInput): string
  /** Revokes by session id or run id. */
  revoke(id: string): void
  /** Revokes everything, or only the tokens of one scope kind. */
  revokeAll(kind?: McpScopeKind): void
  lookup(token: string): McpScope | null
}

/** Session id or run id: the owner a token and its rate limit belong to. */
export const scopeId = (scope: McpScope): string =>
  scope.kind === 'session' ? scope.sessionId : scope.runId

function normalize(scope: McpScopeInput): McpScope {
  if ('kind' in scope && (scope.kind === 'optimize' || scope.kind === 'assistant')) {
    return Object.freeze({ kind: scope.kind, runId: scope.runId, accountId: scope.accountId })
  }
  const { sessionId, projectId, accountId } = scope as Omit<SessionScope, 'kind'>
  return Object.freeze({ kind: 'session', sessionId, projectId, accountId })
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

// Keys are hashes of the tokens, so a lookup's timing depends on the hash of the attacker's
// input rather than on how many leading characters of a real token it matches.
const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

/** In-memory only: tokens die with the app and are never written to disk. */
export function createSessionTokens(): SessionTokens {
  const scopes = new Map<string, McpScope>()
  const byOwner = new Map<string, string>()

  const revoke = (id: string): void => {
    const key = byOwner.get(id)
    if (key === undefined) return
    scopes.delete(key)
    byOwner.delete(id)
  }

  return {
    issue(input) {
      const scope = normalize(input)
      const owner = scopeId(scope)
      revoke(owner)
      const token = randomBytes(32).toString('hex')
      const key = digest(token)
      scopes.set(key, scope)
      byOwner.set(owner, key)
      return token
    },
    revoke,
    revokeAll(kind) {
      if (kind === undefined) {
        scopes.clear()
        byOwner.clear()
        return
      }
      for (const [key, scope] of scopes) {
        if (scope.kind !== kind) continue
        scopes.delete(key)
        byOwner.delete(scopeId(scope))
      }
    },
    lookup(token) {
      if (!TOKEN_PATTERN.test(token)) return null
      return scopes.get(digest(token)) ?? null
    }
  }
}
