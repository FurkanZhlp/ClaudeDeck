import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStopProcess } from './stopProcess'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStopProcess', () => {
  it('sends SIGTERM to the group, then SIGKILL if it is still there (POSIX)', () => {
    const calls: [number | undefined, string][] = []
    const killTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
      calls.push([child.pid, signal])
    }
    const alive = vi.fn()
    createStopProcess('darwin', killTree, alive, 3000)(300)
    expect(calls).toEqual([[300, 'SIGTERM']])
    vi.advanceTimersByTime(3000)
    expect(alive).toHaveBeenCalledWith(-300, 0)
    expect(calls).toEqual([
      [300, 'SIGTERM'],
      [300, 'SIGKILL']
    ])
  })

  it('stops after SIGTERM when the group is gone', () => {
    const killTree = vi.fn()
    const gone = vi.fn(() => {
      throw new Error('ESRCH')
    })
    createStopProcess('darwin', killTree, gone, 3000)(300)
    vi.advanceTimersByTime(3000)
    expect(killTree).toHaveBeenCalledTimes(1)
  })

  it('uses taskkill once on Windows and ignores invalid pids', () => {
    const killTree = vi.fn()
    const stop = createStopProcess('win32', killTree, vi.fn(), 3000)
    stop(1)
    stop(0)
    stop(42)
    vi.advanceTimersByTime(5000)
    expect(killTree).toHaveBeenCalledTimes(1)
    expect((killTree.mock.calls[0][0] as ChildProcess).pid).toBe(42)
  })
})
