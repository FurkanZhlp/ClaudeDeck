import type { ChildProcess } from 'node:child_process'
import type { ProcessInfo } from '../platform/processList'
import type { KillTree, OsName } from '../platform/types'
import type { StopTarget } from './processMatch'

/** Time a stopped test gets to exit on SIGTERM before its group gets SIGKILL (POSIX). */
export const STOP_KILL_DELAY_MS = 3000

type Signal = (pid: number, signal: NodeJS.Signals | 0) => void

export interface StopProcessDeps {
  /** Windows: taskkill /T /F through platform.killTree. */
  killTree: KillTree
  /** Fresh process list, read again before SIGKILL. */
  listProcesses(): Promise<ProcessInfo[]>
  signal?: Signal
  delayMs?: number
}

/**
 * The group of `target` may still get SIGKILL: its leader is the same process (command line and
 * start time), or the leader is gone but members remain (a pid is never reused as long as a
 * group with that id exists).
 */
export function sameGroup(list: ProcessInfo[], target: StopTarget): boolean {
  const leader = list.find((p) => p.pid === target.pid)
  if (!leader) return list.some((p) => p.pgid === target.pid)
  return leader.command === target.command && leader.startMs === target.startMs
}

/**
 * Ends a run's process tree. POSIX: SIGTERM to the group led by `target.pid` (never the pid
 * alone), then SIGKILL after a delay if the group is still there and still the same. Windows:
 * `taskkill /T /F` on the process.
 */
export function createStopProcess(os: OsName, deps: StopProcessDeps): (target: StopTarget) => void {
  const signal: Signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig))
  const delayMs = deps.delayMs ?? STOP_KILL_DELAY_MS
  const send = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      signal(pid, sig)
      return true
    } catch {
      return false
    }
  }

  return (target) => {
    const { pid } = target
    if (!Number.isInteger(pid) || pid <= 1) return
    if (os === 'win32') {
      const handle = {
        pid,
        kill: (sig?: NodeJS.Signals) => send(pid, sig ?? 'SIGTERM')
      } as unknown as ChildProcess
      deps.killTree(handle, 'SIGTERM')
      return
    }
    if (!send(-pid, 'SIGTERM')) return
    const timer = setTimeout(() => {
      if (!send(-pid, 0)) return
      deps
        .listProcesses()
        .then((list) => {
          if (sameGroup(list, target)) send(-pid, 'SIGKILL')
        })
        .catch((error: unknown) => console.warn('[test-queue] stop check failed', error))
    }, delayMs)
    timer.unref?.()
  }
}
