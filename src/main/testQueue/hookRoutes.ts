import type { HookRoute } from '../mcp/server'
import { HOOK_PATH_PREFIX } from './hookScript'
import { PASS, type TestQueueService } from './testQueueService'

export const PRE_BODY_LIMIT = 1024 * 1024
export const POST_BODY_LIMIT = 4 * 1024 * 1024

export interface HookRouteDeps {
  service: Pick<TestQueueService, 'pre' | 'post'>
  /** Only tabs with a running pty may queue; a stale token of a closed tab passes through. */
  isLive(sessionId: string): boolean
}

/** `/hooks/test-queue/pre` and `/post` for startMcpServer's `routes`. */
export function testQueueRoutes({ service, isLive }: HookRouteDeps): Record<string, HookRoute> {
  return {
    [`${HOOK_PATH_PREFIX}pre`]: {
      maxBodyBytes: PRE_BODY_LIMIT,
      handle: (scope, payload, signal) =>
        isLive(scope.sessionId) ? service.pre(scope, payload, signal) : PASS
    },
    [`${HOOK_PATH_PREFIX}post`]: {
      maxBodyBytes: POST_BODY_LIMIT,
      handle: (scope, payload) => {
        if (isLive(scope.sessionId)) service.post(scope, payload)
        return PASS
      }
    }
  }
}
