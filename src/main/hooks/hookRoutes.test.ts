import { describe, expect, it, vi } from 'vitest'
import type { SessionScope } from '../mcp/sessionTokens'
import { hookRoutes, POST_BODY_LIMIT, PRE_BODY_LIMIT } from './hookRoutes'
import { QUEUE_MARKER } from './hookScript'

const scope: SessionScope = { kind: 'session', sessionId: 'tab', projectId: 'p', accountId: 'a' }
const DENY = '{"hookSpecificOutput":{"permissionDecision":"deny"}}'

function setup(): {
  routes: ReturnType<typeof hookRoutes>
  guard: { check: ReturnType<typeof vi.fn> }
  service: { pre: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
  state: { live: boolean; queue: boolean }
} {
  const state = { live: true, queue: true }
  const guard = {
    check: vi.fn((_s: SessionScope, p: unknown) => ((p as { deny?: boolean }).deny ? DENY : null))
  }
  const service = { pre: vi.fn(() => Promise.resolve('queued')), post: vi.fn() }
  const routes = hookRoutes({
    guard,
    service,
    queueEnabled: () => state.queue,
    isLive: () => state.live
  })
  return { routes, guard, service, state }
}

describe('hookRoutes', () => {
  const signal = new AbortController().signal

  it('serves /hooks/pre and /hooks/post with their body limits', () => {
    const { routes } = setup()
    expect(routes['/hooks/pre'].maxBodyBytes).toBe(PRE_BODY_LIMIT)
    expect(routes['/hooks/post'].maxBodyBytes).toBe(POST_BODY_LIMIT)
  })

  it('answers a guard decision at once, before the queue', async () => {
    const { routes, service } = setup()
    const pre = routes['/hooks/pre']
    expect(await pre.handle(scope, { tool_name: 'Bash', deny: true }, signal, 'guard')).toBe(DENY)
    expect(service.pre).not.toHaveBeenCalled()
  })

  it('hands allowed shell calls to the queue only while it is on', async () => {
    const { routes, state } = setup()
    const pre = routes['/hooks/pre']
    expect(await pre.handle(scope, { tool_name: 'Bash' }, signal, 'guard')).toBe(QUEUE_MARKER)
    expect(await pre.handle(scope, { tool_name: 'PowerShell' }, signal, 'guard')).toBe(QUEUE_MARKER)
    expect(await pre.handle(scope, { tool_name: 'Write' }, signal, 'guard')).toBe('')
    state.queue = false
    expect(await pre.handle(scope, { tool_name: 'Bash' }, signal, 'guard')).toBe('')
  })

  it('runs queue polls through the service and post events too', async () => {
    const { routes, guard, service } = setup()
    expect(await routes['/hooks/pre'].handle(scope, { x: 1 }, signal, 'pre')).toBe('queued')
    expect(guard.check).not.toHaveBeenCalled()
    expect(await routes['/hooks/post'].handle(scope, { y: 2 }, signal, 'post')).toBe('')
    expect(service.post).toHaveBeenCalledWith(scope, { y: 2 })
  })

  it('passes stale tabs through', async () => {
    const { routes, guard, service, state } = setup()
    state.live = false
    expect(await routes['/hooks/pre'].handle(scope, { deny: true }, signal, 'guard')).toBe('')
    expect(await routes['/hooks/pre'].handle(scope, {}, signal, 'pre')).toBe('')
    await routes['/hooks/post'].handle(scope, {}, signal, 'post')
    expect(guard.check).not.toHaveBeenCalled()
    expect(service.pre).not.toHaveBeenCalled()
    expect(service.post).not.toHaveBeenCalled()
  })
})
