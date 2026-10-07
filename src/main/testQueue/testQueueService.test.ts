import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClassifyResult,
  Project,
  TestQueueLoad,
  TestQueueSettings,
  TestQueueSnapshot
} from '../../shared/types'
import type { SessionScope } from '../mcp/sessionTokens'
import type { ProcessInfo } from '../platform/processList'
import type { SystemLoad } from '../platform/systemLoad'
import { defaultTestQueueSettings } from '../state/testQueueSettings'
import {
  CANCEL_REASON,
  createTestQueueService,
  MAX_RUNS_PER_SESSION,
  MAX_WAIT_REASON,
  PASS,
  type QueueTranscriptEvent,
  type TestQueueService
} from './testQueueService'

const tab = (sessionId: string, accountId = 'acc1', projectId = 'p1'): SessionScope => ({
  kind: 'session',
  sessionId,
  projectId,
  accountId
})
const A = tab('tabA')
const B = tab('tabB')
const OTHER = tab('tabX', 'acc2', 'p2')

let seq = 0
const pre = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: `toolu_${++seq}`,
  ...extra
})
const post = (toolUseId: unknown, response: Record<string, unknown> = {}): unknown => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: toolUseId,
  tool_response: response
})

/** Fake classifier: anything containing "test" is a test run. */
const classify = (command: string): ClassifyResult => ({
  isTest: /\btest\b/.test(command),
  ruleId: /\btest\b/.test(command) ? 'npm-test' : null,
  source: /\btest\b/.test(command) ? 'builtin' : null,
  segment: command,
  excludedBy: null,
  truncated: false
})

function denyReason(body: string): string | null {
  if (!body) return null
  return (JSON.parse(body) as { hookSpecificOutput: { permissionDecisionReason: string } })
    .hookSpecificOutput.permissionDecisionReason
}

let settings: TestQueueSettings
let load: TestQueueLoad | null
let processes: ProcessInfo[]
let killed: number[]
let snapshots: TestQueueSnapshot[]
let transcriptListeners: Map<string, (event: QueueTranscriptEvent) => void>
let projects: Record<string, Project>
let live: Set<string>
let service: TestQueueService
let listCalls: number

const fakeLoad: SystemLoad = {
  sample: vi.fn(() => Promise.resolve(load as TestQueueLoad)),
  current: () => load,
  reset: vi.fn()
}

function create(): TestQueueService {
  let id = 0
  return createTestQueueService({
    settings: () => settings,
    project: (projectId) => projects[projectId],
    classify,
    fingerprint: () => ['npm', 'test'],
    isLive: (sessionId) => live.has(sessionId),
    ptyPid: (sessionId) => (sessionId === 'tabA' ? 100 : sessionId === 'tabB' ? 200 : undefined),
    listProcesses: () => {
      listCalls += 1
      return Promise.resolve(processes)
    },
    killTree: (pid) => killed.push(pid),
    load: fakeLoad,
    cpuCount: () => 8,
    watchTranscript: (sessionId, onEvent) => {
      transcriptListeners.set(sessionId, onEvent)
      return () => transcriptListeners.delete(sessionId)
    },
    onSnapshot: (s) => snapshots.push(s),
    newId: () => `run${++id}`
  })
}

/** Starts a pre hook; `state.body` fills in once the hook is answered. */
function ask(
  scope: SessionScope,
  payload: Record<string, unknown>
): { body: string | null; abort: () => void; toolUseId: string } {
  const controller = new AbortController()
  const state = {
    body: null as string | null,
    abort: () => controller.abort(),
    toolUseId: payload.tool_use_id as string
  }
  void service.pre(scope, payload, controller.signal).then((body) => {
    state.body = body
  })
  return state
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const states = (): string[] => service.snapshot().runs.map((r) => `${r.id}:${r.state}`)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  settings = { ...defaultTestQueueSettings(), enabled: true, mode: 'fixed', maxConcurrent: 2 }
  load = null
  processes = []
  killed = []
  snapshots = []
  listCalls = 0
  transcriptListeners = new Map()
  projects = {
    p1: { id: 'p1', name: 'App', path: '/code/app', accountId: 'acc1' },
    p2: { id: 'p2', name: 'Other', path: '/code/other', accountId: 'acc2' }
  }
  live = new Set(['tabA', 'tabB', 'tabX'])
  service = create()
})

afterEach(() => {
  service.dispose()
  vi.useRealTimers()
})

describe('pass-through', () => {
  it('lets non-test commands, disabled queues and bad payloads through at once', async () => {
    const ls = ask(A, pre('ls -la'))
    await flush()
    expect(ls.body).toBe(PASS)

    expect(await service.pre(A, { tool_name: 'Edit' }, new AbortController().signal)).toBe(PASS)
    expect(
      await service.pre(
        A,
        { ...pre('npm test'), tool_use_id: '../x' },
        new AbortController().signal
      )
    ).toBe(PASS)

    settings = { ...settings, enabled: false }
    expect(await service.pre(A, pre('npm test'), new AbortController().signal)).toBe(PASS)
    expect(service.snapshot().runs).toEqual([])
  })

  it('records the last hook call per account', async () => {
    expect(service.lastCallAt('acc1')).toBeNull()
    await service.pre(A, pre('ls'), new AbortController().signal)
    expect(service.lastCallAt('acc1')).toBe(1_000_000)
  })

  it('passes through once a tab has too many runs', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    for (let i = 0; i < MAX_RUNS_PER_SESSION; i++) ask(A, pre('npm test'))
    await flush()
    const extra = ask(A, pre('npm test'))
    await flush()
    expect(extra.body).toBe(PASS)
    expect(service.snapshot().runs).toHaveLength(MAX_RUNS_PER_SESSION)
  })
})

describe('fixed mode', () => {
  it('holds runs beyond the limit and starts the next one on completion', async () => {
    const one = ask(A, pre('npm test'))
    const two = ask(B, pre('npm test'))
    const three = ask(A, pre('pnpm test', { agent_id: 'agent1', agent_type: 'tester' }))
    await flush()
    expect([one.body, two.body, three.body]).toEqual([PASS, PASS, null])
    expect(states()).toEqual(['run1:starting', 'run2:starting', 'run3:queued'])
    expect(service.snapshot().runs[2]).toMatchObject({ agentId: 'agent1', agentType: 'tester' })

    // A post from another tab with the same id does nothing.
    service.post(B, post(one.toolUseId))
    await flush()
    expect(three.body).toBeNull()

    service.post(A, post(one.toolUseId))
    await flush()
    expect(three.body).toBe(PASS)
    expect(states()).toEqual(['run2:starting', 'run3:starting'])
  })

  it('treats PostToolUseFailure as done', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    const one = ask(A, pre('npm test'))
    const two = ask(A, pre('npm test'))
    await flush()
    service.post(A, { ...(post(one.toolUseId) as object), hook_event_name: 'PostToolUseFailure' })
    await flush()
    expect(two.body).toBe(PASS)
  })

  it('cancels a waiting run with the fixed reason', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    service.cancel('run2')
    await flush()
    expect(denyReason(waiting.body as string)).toBe(CANCEL_REASON)
    expect(states()).toEqual(['run1:starting'])
    expect(() => service.cancel('run1')).toThrow('INVALID')
    expect(() => service.cancel('nope')).toThrow('NOT_FOUND')
  })

  it('drops a waiter whose hook went away', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    waiting.abort()
    await flush()
    expect(states()).toEqual(['run1:starting'])
  })

  it('moves a waiting run and starts one over capacity with run now', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    ask(A, pre('npm test'))
    const third = ask(B, pre('npm test'))
    await flush()
    service.move('run3', 0)
    expect(states()).toEqual(['run1:starting', 'run3:queued', 'run2:queued'])
    expect(() => service.move('run3', -1)).toThrow('INVALID')

    service.runNow('run3')
    await flush()
    expect(third.body).toBe(PASS)
    expect(service.snapshot().runs.find((r) => r.id === 'run3')?.forced).toBe(true)
    expect(states()).toEqual(['run1:starting', 'run3:starting', 'run2:queued'])
  })

  it('releases a stuck run on request', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const second = ask(A, pre('npm test'))
    await flush()
    service.release('run1')
    await flush()
    expect(second.body).toBe(PASS)
    expect(() => service.release('run2')).not.toThrow()
  })
})

describe('max wait', () => {
  it('denies with the retry reason and keeps the place of a retry within 10 minutes', async () => {
    settings = { ...settings, maxConcurrent: 1, maxWaitMinutes: 1 }
    ask(A, pre('npm test'))
    const late = ask(A, pre('npm test --watch=false'))
    await flush()
    vi.setSystemTime(1_030_000)
    const later = ask(B, pre('npm test'))
    await flush()

    await vi.advanceTimersByTimeAsync(31_000)
    expect(denyReason(late.body as string)).toBe(MAX_WAIT_REASON)
    expect(later.body).toBeNull()

    // The retry goes back before the run that arrived after its first try.
    ask(A, pre('npm test --watch=false'))
    await flush()
    const runs = service.snapshot().runs
    expect(runs.map((r) => r.command)).toEqual(['npm test', 'npm test --watch=false', 'npm test'])
    expect(runs[1].enqueuedAt).toBe(1_000_000)
  })

  it('sends a retry after the window to the back', async () => {
    settings = { ...settings, maxConcurrent: 1, maxWaitMinutes: 1 }
    ask(A, pre('npm test'))
    ask(A, pre('npm test x'))
    await flush()
    await vi.advanceTimersByTimeAsync(61_000)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    ask(A, pre('npm test x'))
    await flush()
    expect(service.snapshot().runs[1].enqueuedAt).toBe(Date.now())
  })
})

describe('automatic mode', () => {
  const quiet: TestQueueLoad = {
    cpuPercent: 20,
    availableMemoryPercent: 60,
    saturated: false,
    lowMemory: false,
    sampledAt: 0
  }

  beforeEach(() => {
    settings = {
      ...settings,
      mode: 'auto',
      auto: { ...settings.auto, maxConcurrent: 2, rampUpSeconds: 20 }
    }
  })

  it('starts the first run at once, the next after ramp-up with a quiet load', async () => {
    const one = ask(A, pre('npm test'))
    const two = ask(A, pre('npm test'))
    const three = ask(A, pre('npm test'))
    await flush()
    expect(one.body).toBe(PASS)
    expect(two.body).toBeNull()

    load = quiet
    await vi.advanceTimersByTimeAsync(10_000)
    expect(two.body).toBeNull()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(two.body).toBe(PASS)
    // Never above the automatic limit.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(three.body).toBeNull()
    expect(service.snapshot()).toMatchObject({ mode: 'auto', limit: 2, load: quiet })
  })

  it('waits while the system is saturated or low on memory', async () => {
    ask(A, pre('npm test'))
    const two = ask(A, pre('npm test'))
    await flush()
    load = { ...quiet, saturated: true }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(two.body).toBeNull()
    load = { ...quiet, lowMemory: true }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(two.body).toBeNull()
    load = quiet
    await vi.advanceTimersByTimeAsync(3_000)
    expect(two.body).toBe(PASS)
  })

  it('samples only while runs exist and resets after', async () => {
    const one = ask(A, pre('npm test'))
    await flush()
    load = quiet
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fakeLoad.sample).toHaveBeenCalled()
    service.post(A, post(one.toolUseId))
    expect(fakeLoad.reset).toHaveBeenCalled()
  })

  it('uses clamp(cpus / 4, 2, 6) without a user limit', () => {
    settings = { ...settings, auto: { ...settings.auto, maxConcurrent: null } }
    expect(service.snapshot().limit).toBe(2)
  })
})

describe('starting, running and background', () => {
  const wrapper = (cmd: string): string =>
    `/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && eval '${cmd}'`

  it('releases a start without evidence after the grace period, probing on the way', async () => {
    settings = { ...settings, startGraceSeconds: 120 }
    ask(A, pre('npm test'))
    await flush()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(listCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(listCalls).toBe(3)
    expect(states()).toEqual([])
  })

  it('finds the process, allows stop with exactly one match, and kills its group', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [
      { pid: 100, ppid: 1, pgid: 100, command: 'claude' },
      { pid: 300, ppid: 100, pgid: 300, command: wrapper('npm test') },
      { pid: 301, ppid: 300, pgid: 300, command: 'node vitest' }
    ]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.snapshot().runs[0]).toMatchObject({ state: 'running', canStop: true })

    await service.stop('run1')
    expect(killed).toEqual([300])

    // A second identical run in the same tab: no longer unambiguous.
    processes = [...processes, { pid: 310, ppid: 100, pgid: 310, command: wrapper('npm test') }]
    await expect(service.stop('run1')).rejects.toThrow('INVALID')
    expect(service.snapshot().runs[0].canStop).toBe(false)
  })

  it('ends a running run whose process disappeared without a post', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [{ pid: 300, ppid: 100, pgid: 300, command: wrapper('npm test') }]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(states()).toEqual(['run1:running'])
    processes = []
    await vi.advanceTimersByTimeAsync(10_000)
    expect(states()).toEqual([])
  })

  it('holds a background run until its task notification arrives', async () => {
    const one = ask(A, pre('npm test'))
    await flush()
    service.post(A, post(one.toolUseId, { backgroundTaskId: 'bash_1' }))
    expect(states()).toEqual(['run1:background'])
    transcriptListeners.get('tabA')?.({ type: 'taskNotification', toolUseId: 'toolu_other' })
    expect(states()).toEqual(['run1:background'])
    transcriptListeners.get('tabA')?.({ type: 'taskNotification', toolUseId: one.toolUseId })
    expect(states()).toEqual([])
    expect(transcriptListeners.has('tabA')).toBe(false)
  })

  it('treats an auto-backgrounded command as background and falls back to max hold', async () => {
    settings = { ...settings, backgroundMaxHoldMinutes: 1 }
    const one = ask(A, pre('npm test'))
    await flush()
    service.post(A, post(one.toolUseId, { timedOutAfterMs: 120000 }))
    expect(states()).toEqual(['run1:background'])
    await vi.advanceTimersByTimeAsync(61_000)
    expect(states()).toEqual([])
  })
})

describe('tab lifecycle and settings', () => {
  it('answers waiters and frees slots when a tab goes away', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const waitingA = ask(A, pre('npm test'))
    const waitingB = ask(B, pre('npm test'))
    await flush()
    service.dropSession('tabA')
    await flush()
    expect(waitingA.body).toBe(PASS)
    expect(waitingB.body).toBe(PASS)
    expect(states()).toEqual(['run3:starting'])
  })

  it('lets everyone go when the queue is turned off', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    settings = { ...settings, enabled: false }
    service.settingsChanged()
    await flush()
    expect(waiting.body).toBe(PASS)
    expect(service.snapshot()).toMatchObject({ enabled: false, runs: [] })
  })

  it('pushes snapshots debounced by 500 ms', async () => {
    ask(A, pre('npm test'))
    ask(A, pre('npm test'))
    await flush()
    expect(snapshots).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].runs).toHaveLength(2)
  })
})

describe('agent access', () => {
  it("shows the caller's account in full and counts the others", async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(OTHER, pre('npm test'))
    ask(A, pre('npm test'))
    ask(OTHER, pre('npm test'))
    await flush()
    const view = service.agentView(B)
    expect(view.runs.map((r) => r.id)).toEqual(['run2'])
    expect(view.otherAccountsRunning).toBe(1)
    expect(view.otherAccountsWaiting).toBe(1)
    expect(JSON.stringify(view)).not.toContain('p2')
  })

  it('cancels only runs of the own tab', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const mine = ask(B, pre('npm test', { agent_id: 'sub1', agent_type: 'x' }))
    await flush()
    await expect(service.cancelOwn(A, 'run2')).rejects.toThrow('NOT_FOUND')
    expect(await service.cancelOwn(B, 'run2')).toBe('cancelled')
    await flush()
    expect(denyReason(mine.body as string)).toBe(CANCEL_REASON)
    // Running without a single matching process cannot be stopped.
    await expect(service.cancelOwn(A, 'run1')).rejects.toThrow('INVALID')
  })
})
