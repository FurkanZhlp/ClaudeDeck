import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { shell } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import { isText, type IpcTools } from '../ipcUtil'
import type { Repository } from '../state/repository'
import { existingNotePath, isSafeMemoryDir, listNotes, readNote } from './notesStore'
import { createNotesSync, type ProjectLocation } from './notesSync'

const CHANGE_DEBOUNCE_MS = 150

interface Deps {
  handle: IpcTools['handle']
  repo: Repository
  send: (channel: string, ...args: unknown[]) => void
  /** True while any terminal of the project is alive. */
  isProjectRunning: (projectId: string) => boolean
}

interface Watch {
  refs: number
  dir: string
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
}

export interface NotesIpc {
  /**
   * Moves the memory folder when a project's account or path changes and re-targets watchers.
   * Deferred while the project runs; copies instead of moving when another project of the old
   * account shares the memory key.
   */
  relocateForProjectChange(before: ProjectLocation, after: ProjectLocation, projectId: string): void
  /** Call before every Claude tab starts: applies deferred moves, merges orphaned notes. */
  prepareProjectMemory(projectId: string): void
  /** Closes all watchers and clears ref counts (renderer reload). */
  reset(): void
  dispose(): void
}

async function openPath(path: string): Promise<null> {
  const error = await shell.openPath(path)
  if (error) {
    console.error('[notes] could not open', error)
    throw new DomainError('UNKNOWN')
  }
  return null
}

export function registerNotesIpc({ handle, repo, send, isProjectRunning }: Deps): NotesIpc {
  const watches = new Map<string, Watch>()
  const sync = createNotesSync({ repo, isProjectRunning })

  const dirOf = (projectId: unknown): string => {
    if (!isText(projectId)) throw new DomainError('INVALID')
    return sync.dirOf(projectId)
  }

  const notify = (projectId: string, entry: Watch): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      send(IPC.notesChanged, projectId)
    }, CHANGE_DEBOUNCE_MS)
  }

  const stop = (entry: Watch): void => {
    entry.watcher?.close()
    entry.watcher = null
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  const start = (projectId: string, entry: Watch): void => {
    stop(entry)
    if (!isSafeMemoryDir(entry.dir)) {
      console.warn('[notes] refusing to watch an unsafe memory folder')
      return
    }
    try {
      mkdirSync(entry.dir, { recursive: true })
      const watcher = watch(entry.dir, () => notify(projectId, entry))
      watcher.on('error', (error) => {
        console.warn('[notes] watcher stopped', error)
        if (entry.watcher === watcher) stop(entry)
      })
      entry.watcher = watcher
    } catch (error) {
      console.warn('[notes] could not watch', error)
    }
  }

  /** Points the project's watcher at its current folder and refreshes the panel. */
  const retarget = (projectId: string, changed: boolean): void => {
    const entry = watches.get(projectId)
    if (!entry) return
    const dir = sync.dirOf(projectId)
    if (dir !== entry.dir) {
      entry.dir = dir
      start(projectId, entry)
      changed = true
    }
    if (changed) notify(projectId, entry)
  }

  const prepare = (projectId: string): boolean => {
    try {
      return sync.prepare(projectId)
    } catch (error) {
      console.warn('[notes] could not prepare project memory', error)
      return false
    }
  }

  handle(IPC.notesList, (projectId: string) => {
    const dir = dirOf(projectId)
    // The listing already includes merged files, so the panel needs no change event.
    prepare(projectId)
    return listNotes(dir)
  })
  handle(IPC.notesRead, (projectId: string, name: string) => readNote(dirOf(projectId), name))

  handle(IPC.notesOpen, (projectId: string, name: string) =>
    openPath(existingNotePath(dirOf(projectId), name))
  )
  handle(IPC.notesReveal, (projectId: string) => {
    const dir = dirOf(projectId)
    if (!isSafeMemoryDir(dir)) throw new DomainError('INVALID')
    mkdirSync(dir, { recursive: true })
    return openPath(dir)
  })

  handle(IPC.notesWatch, (projectId: string) => {
    dirOf(projectId)
    prepare(projectId)
    const dir = sync.dirOf(projectId)
    const existing = watches.get(projectId)
    if (existing) {
      existing.refs++
      if (existing.dir !== dir || !existing.watcher) {
        existing.dir = dir
        start(projectId, existing)
      }
      return null
    }
    const entry: Watch = { refs: 1, dir, watcher: null, timer: null }
    watches.set(projectId, entry)
    start(projectId, entry)
    return null
  })
  handle(IPC.notesUnwatch, (projectId: string) => {
    if (!isText(projectId)) throw new DomainError('INVALID')
    const entry = watches.get(projectId)
    if (entry && --entry.refs <= 0) {
      stop(entry)
      watches.delete(projectId)
    }
    return null
  })

  const reset = (): void => {
    watches.forEach(stop)
    watches.clear()
  }

  return {
    relocateForProjectChange(before, after, projectId) {
      const outcome = sync.relocate(before, after, projectId)
      retarget(projectId, outcome !== 'none')
    },
    prepareProjectMemory(projectId) {
      retarget(projectId, prepare(projectId))
    },
    reset,
    dispose: reset
  }
}
