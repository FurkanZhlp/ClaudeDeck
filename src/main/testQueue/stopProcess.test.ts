import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessInfo } from '../platform/processList'
import type { StopTarget } from './processMatch'
import { createStopProcess, sameGroup } from './stopProcess'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const target: StopTarget = { pid: 300, command: '/bin/zsh -c wrapper', startMs: 5000 }
const leader: ProcessInfo = {
  pid: 300,
  ppid: 100,
  pgid: 300,
  startMs: 5000,
  command: target.command
}
const member: ProcessInfo = { pid: 301, ppid: 300, pgid: 300, startMs: 5000, command: 'vitest' }

function setup(
  list: ProcessInfo[],
  alive = true
): {
  signals: [number, NodeJS.Signals | 0][]
  killTree: ReturnType<typeof vi.fn>
  stop: (target: StopTarget) => void
} {
  const signals: [number, NodeJS.Signals | 0][] = []
  const killTree = vi.fn()
  const stop = createStopProcess('darwin', {
    killTree,
    listProcesses: () => Promise.resolve(list),
    signal: (pid, sig) => {
      signals.push([pid, sig])
      if (sig === 0 && !alive) throw new Error('ESRCH')
    },
    delayMs: 3000
  })
  return { signals, killTree, stop }
}

describe('createStopProcess (POSIX)', () => {
  it('signals only the group: SIGTERM, then SIGKILL when the same leader is still there', async () => {
    const { signals, killTree, stop } = setup([leader, member])
    stop(target)
    expect(signals).toEqual([[-300, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(3000)
    expect(signals).toEqual([
      [-300, 'SIGTERM'],
      [-300, 0],
      [-300, 'SIGKILL']
    ])
    expect(killTree).not.toHaveBeenCalled()
  })

  it('stops after SIGTERM when the group is gone', async () => {
    const { signals, stop } = setup([], false)
    stop(target)
    await vi.advanceTimersByTimeAsync(3000)
    expect(signals).toEqual([
      [-300, 'SIGTERM'],
      [-300, 0]
    ])
  })

  it('does not escalate when the pid now leads another process', async () => {
    const reused = { ...leader, startMs: 9000, command: 'other' }
    const { signals, stop } = setup([reused])
    stop(target)
    await vi.advanceTimersByTimeAsync(3000)
    expect(signals.some(([, sig]) => sig === 'SIGKILL')).toBe(false)
  })

  it('never falls back to the positive pid when the group signal fails', async () => {
    const signals: [number, NodeJS.Signals | 0][] = []
    const stop = createStopProcess('darwin', {
      killTree: vi.fn(),
      listProcesses: () => Promise.resolve([leader]),
      signal: (pid, sig) => {
        signals.push([pid, sig])
        throw new Error('EPERM')
      }
    })
    stop(target)
    await vi.advanceTimersByTimeAsync(5000)
    expect(signals).toEqual([[-300, 'SIGTERM']])
  })
})

describe('sameGroup', () => {
  it('accepts the same leader or a leaderless group, refuses a different leader', () => {
    expect(sameGroup([leader, member], target)).toBe(true)
    expect(sameGroup([member], target)).toBe(true)
    expect(sameGroup([], target)).toBe(false)
    expect(sameGroup([{ ...leader, command: 'x' }], target)).toBe(false)
    expect(sameGroup([{ ...leader, startMs: 1 }], target)).toBe(false)
  })
})

describe('createStopProcess (Windows)', () => {
  it('uses taskkill once and ignores invalid pids', async () => {
    const killTree = vi.fn()
    const stop = createStopProcess('win32', {
      killTree,
      listProcesses: () => Promise.resolve([]),
      signal: vi.fn()
    })
    stop({ ...target, pid: 1 })
    stop({ ...target, pid: 0 })
    stop({ ...target, pid: 42 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(killTree).toHaveBeenCalledTimes(1)
    expect((killTree.mock.calls[0][0] as ChildProcess).pid).toBe(42)
  })
})
