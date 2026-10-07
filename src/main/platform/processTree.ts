import { spawn, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import { WIN_DEFAULT_SYSTEM_ROOT, WIN_TASKKILL } from './constants'
import type { KillTree, OsName } from './types'

/**
 * POSIX: detached, so the spawned shell leads its own process group and `killTree` reaches
 * claude and its children. Windows: detached would open a console window.
 */
export function spawnDefaults(os: OsName): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return os === 'win32' ? { detached: false, windowsHide: true } : { detached: true }
}

const posixKillTree: KillTree = (child, signal) => {
  try {
    // Detached: the shell leads its own process group, so claude and its children go too.
    if (child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildLike

interface ChildLike {
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Windows has no process groups or signals: `taskkill /T /F` ends the process and every child
 * (claude, its tools, MCP servers). Falls back to killing the direct child if taskkill fails.
 */
export function windowsKillTree(
  spawnFn: Spawn = spawn,
  systemRoot: string = process.env.SystemRoot || WIN_DEFAULT_SYSTEM_ROOT
): KillTree {
  const taskkill = win32.join(systemRoot, ...WIN_TASKKILL)
  return (child, signal) => {
    if (child.pid === undefined) {
      child.kill(signal)
      return
    }
    const fallback = (): void => {
      child.kill(signal)
    }
    try {
      spawnFn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      }).on('error', fallback)
    } catch {
      fallback()
    }
  }
}

export function killTree(os: OsName): KillTree {
  return os === 'win32' ? windowsKillTree() : posixKillTree
}
