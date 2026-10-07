import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { ClassifyResult, Project } from '../../shared/types'
import type { Handler } from '../ipcUtil'
import { defaultTestQueueSettings } from '../state/testQueueSettings'
import { registerTestQueueIpc } from './testQueueIpc'
import type { TestQueueService } from './testQueueService'

const result: ClassifyResult = {
  isTest: true,
  ruleId: 'npm-test',
  source: 'builtin',
  segment: 'npm test',
  excludedBy: null,
  truncated: false
}

interface Setup {
  call: (channel: string, ...args: unknown[]) => unknown
  service: Record<string, ReturnType<typeof vi.fn>>
  classify: ReturnType<typeof vi.fn>
  project: ReturnType<typeof vi.fn>
}

function setup(): Setup {
  const handlers = new Map<string, Handler>()
  const service = {
    snapshot: vi.fn(() => ({ runs: [] })),
    cancel: vi.fn(() => 'cancelled'),
    move: vi.fn(() => 'moved'),
    runNow: vi.fn(() => 'started'),
    release: vi.fn(() => 'released'),
    stop: vi.fn(() => Promise.resolve('stopped'))
  }
  const classify = vi.fn(() => result)
  const project = vi.fn((id: string): Project => {
    if (id !== 'p1') throw new DomainError('NOT_FOUND')
    return {
      id,
      name: 'App',
      path: '/code/app',
      accountId: 'a1',
      testQueue: { mode: 'off', disabledBuiltins: [], customPatterns: [] }
    }
  })
  registerTestQueueIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    service: service as unknown as TestQueueService,
    hooks: { status: vi.fn(() => Promise.resolve({ accounts: [] }) as never) },
    settings: () => defaultTestQueueSettings(),
    project,
    classify,
    builtins: () => []
  })
  const call = (channel: string, ...args: unknown[]): unknown => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(...args)
  }
  return { call, service, classify, project }
}

describe('registerTestQueueIpc', () => {
  it('passes valid run ids through', async () => {
    const { call, service } = setup()
    expect(call(IPC.testQueueCancel, 'run1')).toBe('cancelled')
    expect(call(IPC.testQueueMove, 'run1', 2)).toBe('moved')
    expect(call(IPC.testQueueRunNow, 'run1')).toBe('started')
    expect(call(IPC.testQueueRelease, 'run1')).toBe('released')
    expect(await call(IPC.testQueueStop, 'run1')).toBe('stopped')
    expect(service.move).toHaveBeenCalledWith('run1', 2)
  })

  it.each([
    [IPC.testQueueCancel, [undefined]],
    [IPC.testQueueCancel, ['']],
    [IPC.testQueueRunNow, [42]],
    [IPC.testQueueRelease, ['x'.repeat(101)]],
    [IPC.testQueueStop, [{ id: 'run1' }]],
    [IPC.testQueueMove, ['run1', '2']],
    [IPC.testQueueMove, [null, 0]]
  ])('refuses bad arguments for %s', (channel, args) => {
    const { call, service } = setup()
    expect(() => call(channel, ...args)).toThrow('INVALID')
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })

  it('classifies with the global rules and the project overrides', () => {
    const { call, classify } = setup()
    expect(call(IPC.testQueueClassify, 'npm test')).toBe(result)
    expect(classify).toHaveBeenLastCalledWith('npm test', {
      disabledBuiltins: [],
      customPatterns: [],
      projectOverrides: undefined
    })
    call(IPC.testQueueClassify, 'npm test', 'p1')
    expect(classify).toHaveBeenLastCalledWith(
      'npm test',
      expect.objectContaining({ projectOverrides: expect.objectContaining({ mode: 'off' }) })
    )
  })

  it('refuses bad classify arguments and unknown projects', () => {
    const { call, classify } = setup()
    expect(() => call(IPC.testQueueClassify, 42)).toThrow('INVALID')
    expect(() => call(IPC.testQueueClassify, 'x'.repeat(64 * 1024 + 1))).toThrow('INVALID')
    expect(() => call(IPC.testQueueClassify, 'npm test', 7)).toThrow('INVALID')
    expect(() => call(IPC.testQueueClassify, 'npm test', 'nope')).toThrow('NOT_FOUND')
    expect(classify).not.toHaveBeenCalled()
  })

  it('serves the snapshot, hook status and built-ins', async () => {
    const { call } = setup()
    expect(call(IPC.testQueueList)).toEqual({ runs: [] })
    expect(await call(IPC.testQueueHookStatus)).toEqual({ accounts: [] })
    expect(call(IPC.testQueueBuiltins)).toEqual([])
  })
})
