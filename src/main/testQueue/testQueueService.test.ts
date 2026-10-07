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
  ABANDON_AFTER_MS,
  CANCEL_REASON,
  createTestQueueService,
  POLL_HOLD_MS,
  MAX_RUNS_PER_SESSION,
  MAX_WAIT_REASON,
  PASS,
  WAIT,
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
    killTree: (target) => killed.push(target.pid),
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

interface Asked {
  body: string | null
  /** Polls made so far (the hook script polls again after each WAIT). */
  polls: number
  abort: () => void
  /** Stops polling after the current poll, like a hook killed with SIGKILL. */
  vanish: () => void
  toolUseId: string
}

/** Runs a pre hook like the script does; `state.body` fills in once there is a decision. */
function ask(scope: SessionScope, payload: Record<string, unknown>): Asked {
  let controller = new AbortController()
  let gone = false
  const state: Asked = {
    body: null,
    polls: 0,
    abort: () => controller.abort(),
    vanish: () => {
      gone = true
    },
    toolUseId: payload.tool_use_id as string
  }
  const poll = (): void => {
    state.polls += 1
    controller = new AbortController()
    void service.pre(scope, payload, controller.signal).then((body) => {
      if (body !== WAIT) state.body = body
      else if (!gone) poll()
    })
  }
  poll()
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
    // 30 s, 60 s, then every 15 s: 75, 90, 105 s.
    await vi.advanceTimersByTimeAsync(108_000)
    expect(listCalls).toBe(6)
    expect(states()).toEqual(['run1:starting'])
    // At the end of the grace one more check runs before the slot is released.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(listCalls).toBe(7)
    expect(states()).toEqual([])
  })

  it('keeps a run whose process shows up in the final grace check', async () => {
    settings = { ...settings, startGraceSeconds: 70 }
    ask(A, pre('npm test'))
    await flush()
    await vi.advanceTimersByTimeAsync(65_000)
    processes = [
      { pid: 300, ppid: 100, pgid: 300, startMs: 1_001_000, command: wrapper('npm test') }
    ]
    await vi.advanceTimersByTimeAsync(6_000)
    expect(states()).toEqual(['run1:running'])
  })

  it('finds the process, allows stop with exactly one match, and kills its group', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [
      { pid: 100, ppid: 1, pgid: 100, startMs: 1, command: 'claude' },
      { pid: 300, ppid: 100, pgid: 300, startMs: 1_001_000, command: wrapper('npm test') },
      { pid: 301, ppid: 300, pgid: 300, startMs: 1_001_000, command: 'node vitest' }
    ]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.snapshot().runs[0]).toMatchObject({ state: 'running', canStop: true })

    await service.stop('run1')
    expect(killed).toEqual([300])

    // A second identical run in the same tab: no longer unambiguous.
    processes = [
      ...processes,
      { pid: 310, ppid: 100, pgid: 310, startMs: 1_001_000, command: wrapper('npm test') }
    ]
    await expect(service.stop('run1')).rejects.toThrow('INVALID')
    expect(service.snapshot().runs[0].canStop).toBe(false)
  })

  it('ends a running run whose process disappeared without a post', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [
      { pid: 300, ppid: 100, pgid: 300, startMs: 1_001_000, command: wrapper('npm test') }
    ]
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

  it('cancels and stops only runs of the own tab', async () => {
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

describe('short polls', () => {
  beforeEach(() => {
    settings = { ...settings, maxConcurrent: 1, startGraceSeconds: 900 }
  })

  it('answers a held poll with WAIT and keeps the place when the script polls again', async () => {
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS + 1000)
    expect(waiting.polls).toBe(2)
    expect(waiting.body).toBeNull()
    await vi.advanceTimersByTimeAsync(5 * POLL_HOLD_MS)
    expect(states()).toEqual(['run1:starting', 'run2:queued'])
    service.release('run1')
    await flush()
    expect(waiting.body).toBe(PASS)
  })

  it('drops a waiter whose script stopped polling', async () => {
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    waiting.vanish()
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS + 1000)
    expect(states()).toEqual(['run1:starting', 'run2:queued'])
    await vi.advanceTimersByTimeAsync(ABANDON_AFTER_MS)
    expect(states()).toEqual(['run1:starting'])
    expect(service.snapshot().runs).toHaveLength(1)
  })

  it('keeps a decision made between two polls for the next poll', async () => {
    ask(A, pre('npm test'))
    const payload = pre('npm test')
    const controller = new AbortController()
    const first = service.pre(A, payload, controller.signal)
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS + 1000)
    expect(await first).toBe(WAIT)
    // Between polls: the user cancels it.
    service.cancel('run2')
    expect(denyReason(await service.pre(A, payload, controller.signal))).toBe(CANCEL_REASON)
    // The decision is handed out once; no new run is created.
    expect(states()).toEqual(['run1:starting'])
  })

  it('lets a started run through on the next poll, or drops it when that poll never comes', async () => {
    const one = ask(A, pre('npm test'))
    const payload = pre('npm test')
    void service.pre(A, payload, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS + 1000)
    service.post(A, post(one.toolUseId))
    expect(states()).toEqual(['run2:starting'])
    expect(await service.pre(A, payload, new AbortController().signal)).toBe(PASS)
    await vi.advanceTimersByTimeAsync(ABANDON_AFTER_MS + 1000)
    expect(states()).toEqual(['run2:starting'])

    // Same again, but the script is gone: the slot is freed.
    const three = ask(B, pre('npm test'))
    const gone = pre('npm test')
    void service.pre(B, gone, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(POLL_HOLD_MS + 1000)
    service.release('run2')
    await flush()
    expect(three.body).toBe(PASS)
    service.post(B, post(three.toolUseId))
    expect(states()).toEqual(['run4:starting'])
    await vi.advanceTimersByTimeAsync(ABANDON_AFTER_MS + 1000)
    expect(states()).toEqual([])
  })

  it('lets a second hook for the same call go and answers a late poll of a started run', async () => {
    const payload = pre('npm test')
    ask(A, pre('npm test'))
    const first = service.pre(A, payload, new AbortController().signal)
    const second = service.pre(A, payload, new AbortController().signal)
    expect(await first).toBe(PASS)
    expect(states()).toEqual(['run1:starting', 'run2:queued'])
    service.release('run1')
    expect(await second).toBe(PASS)
    expect(await service.pre(A, payload, new AbortController().signal)).toBe(PASS)
    expect(states()).toEqual(['run2:starting'])
  })
})

describe('post hooks and bulk removal', () => {
  it('abandons a queued run when its call ends without running (Esc, failure)', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const waiting = ask(A, pre('npm test'))
    await flush()
    service.post(A, {
      ...(post(waiting.toolUseId) as object),
      hook_event_name: 'PostToolUseFailure'
    })
    expect(states()).toEqual(['run1:starting'])
  })

  it('abandons a starting run interrupted by the user, finishes it otherwise', async () => {
    const one = ask(A, pre('npm test'))
    const two = ask(A, pre('npm test'))
    await flush()
    service.post(A, {
      ...(post(one.toolUseId) as object),
      hook_event_name: 'PostToolUseFailure',
      is_interrupt: true
    })
    service.post(A, post(two.toolUseId))
    expect(states()).toEqual([])
  })

  it('does not start waiting runs while removing them in bulk', async () => {
    settings = { ...settings, maxConcurrent: 1 }
    ask(A, pre('npm test'))
    const queued = ask(A, pre('npm test'))
    const other = ask(B, pre('npm test'))
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    snapshots = []
    service.dropAll()
    await flush()
    expect(queued.body).toBe(PASS)
    expect(other.body).toBe(PASS)
    expect(states()).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    expect(snapshots.at(-1)?.runs).toEqual([])
  })

  it('admits nothing while the queue is turned off', async () => {
    settings = { ...settings, maxConcurrent: 1, enabled: false }
    service.settingsChanged()
    expect(service.snapshot().runs).toEqual([])
  })
})

describe('stop safety', () => {
  const wrapper = (cmd: string): string =>
    `/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && eval '${cmd}'`

  it('refuses to stop a process that started before the run', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [
      { pid: 100, ppid: 1, pgid: 100, startMs: 1, command: 'claude' },
      { pid: 300, ppid: 100, pgid: 300, startMs: 990_000, command: wrapper('npm test') }
    ]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.snapshot().runs[0]).toMatchObject({ state: 'running', canStop: false })
    await expect(service.stop('run1')).rejects.toThrow('INVALID')
    expect(killed).toEqual([])
  })

  it('refuses to stop a run found by its runner tokens only', async () => {
    ask(A, pre('npm test'))
    await flush()
    processes = [
      { pid: 100, ppid: 1, pgid: 100, startMs: 1, command: 'claude' },
      { pid: 300, ppid: 100, pgid: 300, startMs: 1_001_000, command: 'sh -c x' },
      { pid: 301, ppid: 300, pgid: 300, startMs: 1_001_000, command: 'npm test' }
    ]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.snapshot().runs[0]).toMatchObject({ state: 'running', canStop: false })
  })
})
