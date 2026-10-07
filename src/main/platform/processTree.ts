import type { SpawnOptions } from 'node:child_process'
import { NOT_IMPLEMENTED } from './constants'
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

const win32KillTree: KillTree = () => {
  throw new Error(NOT_IMPLEMENTED)
}

export function killTree(os: OsName): KillTree {
  return os === 'win32' ? win32KillTree : posixKillTree
}
