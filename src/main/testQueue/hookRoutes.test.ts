import { describe, expect, it, vi } from 'vitest'
import type { SessionScope } from '../mcp/sessionTokens'
import { POST_BODY_LIMIT, PRE_BODY_LIMIT, testQueueRoutes } from './hookRoutes'

const scope: SessionScope = { kind: 'session', sessionId: 'tab', projectId: 'p', accountId: 'a' }

describe('testQueueRoutes', () => {
  it('serves pre and post with their body limits, only for live tabs', async () => {
    const service = { pre: vi.fn(() => Promise.resolve('deny')), post: vi.fn() }
    let live = true
    const routes = testQueueRoutes({ service, isLive: () => live })
    const pre = routes['/hooks/test-queue/pre']
    const post = routes['/hooks/test-queue/post']
    expect(pre.maxBodyBytes).toBe(PRE_BODY_LIMIT)
    expect(post.maxBodyBytes).toBe(POST_BODY_LIMIT)

    const signal = new AbortController().signal
    expect(await pre.handle(scope, { x: 1 }, signal)).toBe('deny')
    expect(await post.handle(scope, { y: 2 }, signal)).toBe('')
    expect(service.post).toHaveBeenCalledWith(scope, { y: 2 })

    live = false
    expect(await pre.handle(scope, {}, signal)).toBe('')
    await post.handle(scope, {}, signal)
    expect(service.pre).toHaveBeenCalledTimes(1)
    expect(service.post).toHaveBeenCalledTimes(1)
  })
})
