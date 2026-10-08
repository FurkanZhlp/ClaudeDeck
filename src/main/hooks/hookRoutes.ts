import type { GuardCaller } from '../guard/guardService'
import type { AccountScope, HookRoute, RouteScope } from '../mcp/server'
import type { SessionScope } from '../mcp/sessionTokens'
import { isObject } from '../profile/settingsFile'
import { PASS, type TestQueueService } from '../testQueue/testQueueService'
import { GUARD_ROUTE, GUARD_STEP, HOOK_PATH_PREFIX, QUEUE_MARKER } from './hookScript'

/** Write and NotebookEdit calls carry the whole file; a large one must still reach the guard. */
export const PRE_BODY_LIMIT = 16 * 1024 * 1024
export const POST_BODY_LIMIT = 4 * 1024 * 1024

/** Tools the test queue handles. */
const QUEUE_TOOLS = new Set(['Bash', 'PowerShell'])

export interface HookRouteDeps {
  guard: { check(caller: GuardCaller, payload: unknown): Promise<string | null> | string | null }
  /** The account of a guard key (guard-only calls of claude processes without a tab token). */
  accountForKey?: (key: string) => string | null
  service: Pick<TestQueueService, 'pre' | 'post'>
  /** The test queue is on (global setting). */
  queueEnabled(): boolean
  /** Only tabs with a running pty are handled; a stale token of a closed tab passes through. */
  isLive(sessionId: string): boolean
}

/**
 * `/hooks/pre` and `/hooks/post` for startMcpServer's `routes`.
 * - pre, guard step (`e: guard`): the guard decides first; a deny or ask is answered at once.
 *   An allowed Bash or PowerShell call answers QUEUE_MARKER while the queue is on, so the
 *   script goes on with the queue polls.
 * - pre, queue polls (`e: pre`): the test queue.
 * - post: the test queue only.
 */
export function hookRoutes({
  guard,
  service,
  queueEnabled,
  isLive,
  accountForKey
}: HookRouteDeps): Record<string, HookRoute> {
  const tab = (scope: RouteScope): SessionScope | null =>
    scope.kind === 'session' && isLive(scope.sessionId) ? scope : null
  const routes: Record<string, HookRoute> = {
    [`${HOOK_PATH_PREFIX}pre`]: {
      maxBodyBytes: PRE_BODY_LIMIT,
      handle: async (scope, payload, signal, event) => {
        const session = tab(scope)
        if (!session) return PASS
        if (event === GUARD_STEP) {
          const reply = await guard.check(session, payload)
          if (reply !== null) return reply
          const queued =
            queueEnabled() && isObject(payload) && QUEUE_TOOLS.has(String(payload.tool_name))
          return queued ? QUEUE_MARKER : PASS
        }
        return service.pre(session, payload, signal)
      }
    },
    [`${HOOK_PATH_PREFIX}post`]: {
      maxBodyBytes: POST_BODY_LIMIT,
      handle: (scope, payload) => {
        const session = tab(scope)
        if (session) service.post(session, payload)
        return PASS
      }
    }
  }
  if (accountForKey) {
    // Guard only, for claude processes without a tab token (nested runs with a cleared env).
    routes[`${HOOK_PATH_PREFIX}${GUARD_ROUTE}`] = {
      maxBodyBytes: PRE_BODY_LIMIT,
      authenticate: (key): AccountScope | null => {
        const accountId = accountForKey(key)
        return accountId ? { kind: 'account', accountId } : null
      },
      handle: async (scope, payload, _signal, event) => {
        if (scope.kind !== 'account' || event !== GUARD_STEP) return PASS
        return (await guard.check(scope, payload)) ?? PASS
      }
    }
  }
  return routes
}
