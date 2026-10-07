import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentOpenResult, AgentSummary } from '@shared/types'
import { runningCount, useAgents } from './agentsStore'

const summary = (agentId: string, status: AgentSummary['status'] = 'running'): AgentSummary => ({
  agentId,
  agentType: 'general-purpose',
  description: agentId,
  model: null,
  background: false,
  depth: 1,
  status,
  startedAt: 0,
  lastActivityAt: 0
})

const ev = (id: string): AgentEvent => ({ id, kind: 'text', at: 0, text: id })

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const api = {
  watch: vi.fn<(sessionId: string) => Promise<AgentSummary[]>>(),
  unwatch: vi.fn(() => Promise.resolve(null)),
  list: vi.fn(),
  open: vi.fn<(sessionId: string, agentId: string) => Promise<AgentOpenResult>>(),
  close: vi.fn(() => Promise.resolve(null)),
  older: vi.fn<(sessionId: string, agentId: string, cursor: number) => Promise<AgentOpenResult>>(),
  onUpdate: vi.fn(),
  onEvents: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api: { agents: api } }
  useAgents.setState({ sessionId: null, agents: null, listFailed: false, open: null })
})

describe('agents store', () => {
  it('watches a tab and takes pushed summaries for it only', async () => {
    api.watch.mockResolvedValue([summary('a')])
    await useAgents.getState().watch('s1')
    expect(useAgents.getState().agents).toHaveLength(1)

    useAgents.getState().applyUpdate('other', [])
    expect(useAgents.getState().agents).toHaveLength(1)
    useAgents.getState().applyUpdate('s1', [summary('a', 'done'), summary('b')])
    expect(runningCount(useAgents.getState().agents)).toBe(1)
  })

  it('keeps a push that arrived before the watch reply', async () => {
    const reply = deferred<AgentSummary[]>()
    api.watch.mockReturnValue(reply.promise)
    const watching = useAgents.getState().watch('s1')
    useAgents.getState().applyUpdate('s1', [summary('a'), summary('b')])
    reply.resolve([summary('a')])
    await watching
    expect(useAgents.getState().agents).toHaveLength(2)
  })

  it('ignores a late watch reply for a tab that was switched away', async () => {
    const reply = deferred<AgentSummary[]>()
    api.watch.mockReturnValueOnce(reply.promise).mockResolvedValueOnce([])
    const first = useAgents.getState().watch('s1')
    useAgents.getState().unwatch('s1')
    await useAgents.getState().watch('s2')
    reply.resolve([summary('a')])
    await first
    expect(useAgents.getState()).toMatchObject({ sessionId: 's2', agents: [] })
    expect(api.unwatch).toHaveBeenCalledTimes(1)
  })

  it('marks a failed watch instead of showing an empty list', async () => {
    api.watch.mockRejectedValue(new Error('NOT_FOUND'))
    await useAgents.getState().watch('s1')
    expect(useAgents.getState()).toMatchObject({ agents: [], listFailed: true })
  })

  it('opens an agent, merges live events received while loading, and pages older events', async () => {
    api.watch.mockResolvedValue([summary('a')])
    await useAgents.getState().watch('s1')
    const page = deferred<AgentOpenResult>()
    api.open.mockReturnValue(page.promise)
    const opening = useAgents.getState().openAgent('a')
    useAgents.getState().applyEvents('s1', 'a', [ev('30:0')])
    useAgents.getState().applyEvents('s1', 'b', [ev('99:0')])
    page.resolve({ events: [ev('10:0'), ev('20:0'), ev('30:0')], cursor: 10 })
    await opening

    let open = useAgents.getState().open
    expect(open?.events.map((e) => e.id)).toEqual(['10:0', '20:0', '30:0'])
    expect(open).toMatchObject({ loading: false, cursor: 10 })

    api.older.mockResolvedValue({ events: [ev('0:0')], cursor: null })
    await useAgents.getState().loadOlder()
    expect(api.older).toHaveBeenCalledWith('s1', 'a', 10)
    open = useAgents.getState().open
    expect(open?.events.map((e) => e.id)).toEqual(['0:0', '10:0', '20:0', '30:0'])
    expect(open?.cursor).toBeNull()

    await useAgents.getState().loadOlder()
    expect(api.older).toHaveBeenCalledTimes(1)
  })

  it('closes the previous agent in main when another opens or the tab is unwatched', async () => {
    api.watch.mockResolvedValue([summary('a'), summary('b')])
    api.open.mockResolvedValue({ events: [], cursor: null })
    await useAgents.getState().watch('s1')
    await useAgents.getState().openAgent('a')
    await useAgents.getState().openAgent('b')
    expect(api.close).toHaveBeenCalledWith('s1', 'a')
    useAgents.getState().unwatch('s1')
    expect(api.close).toHaveBeenCalledWith('s1', 'b')
    expect(useAgents.getState()).toMatchObject({ sessionId: null, agents: null, open: null })
  })

  it('shows a failed open so the view can go back', async () => {
    api.watch.mockResolvedValue([summary('a')])
    api.open.mockRejectedValue(new Error('NOT_FOUND'))
    await useAgents.getState().watch('s1')
    await useAgents.getState().openAgent('a')
    expect(useAgents.getState().open).toMatchObject({ agentId: 'a', failed: true, loading: false })
  })
})
