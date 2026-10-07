import type { ChildProcess } from 'node:child_process'
import type { KillTree, OsName } from '../platform/types'

/** Time a stopped test gets to exit on SIGTERM before its group gets SIGKILL (POSIX). */
export const STOP_KILL_DELAY_MS = 3000

type Signal = (pid: number, signal: NodeJS.Signals | 0) => void

/**
 * Ends a run's process tree through platform.killTree, which takes a child process: POSIX
 * kills the group led by `pid` (SIGTERM, then SIGKILL if it is still there), Windows runs
 * `taskkill /T /F` on `pid`.
 */
export function createStopProcess(
  os: OsName,
  killTree: KillTree,
  signal: Signal = (pid, sig) => process.kill(pid, sig),
  delayMs: number = STOP_KILL_DELAY_MS
): (pid: number) => void {
  const handle = (pid: number): ChildProcess =>
    ({
      pid,
      kill: (sig?: NodeJS.Signals) => {
        try {
          signal(pid, sig ?? 'SIGTERM')
          return true
        } catch {
          return false
        }
      }
    }) as unknown as ChildProcess
  return (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return
    killTree(handle(pid), 'SIGTERM')
    if (os === 'win32') return
    const timer = setTimeout(() => {
      try {
        signal(-pid, 0)
      } catch {
        return
      }
      killTree(handle(pid), 'SIGKILL')
    }, delayMs)
    timer.unref?.()
  }
}
