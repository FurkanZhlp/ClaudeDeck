import { lstatSync, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { shell } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import { isText, type IpcTools } from '../ipcUtil'
import { isWithin, samePath } from '../platform/paths'
import type { OsName } from '../platform/types'
import type { Repository } from '../state/repository'
import {
  existingNotePath,
  isSafeMemoryDir,
  listNotes,
  readNote,
  relocateMemory
} from './notesStore'
import { createNotesSync, type NotesSyncDeps, type ProjectLocation } from './notesSync'

const CHANGE_DEBOUNCE_MS = 150

interface Deps {
  handle: IpcTools['handle']
  repo: Repository
  send: (channel: string, ...args: unknown[]) => void
  /** True while any terminal of the project is alive. */
  isProjectRunning: (projectId: string) => boolean
  /** Only Windows locks watched folders; elsewhere watchers stay open during relocations. */
  os?: OsName
  /** `fs.watch` (tests). */
  watch?: (dir: string, listener: () => void) => FSWatcher
  /** Memory key of a project folder (tests). */
  resolveKey?: NotesSyncDeps['resolveKey']
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

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** One folder is the other or lies inside it. */
const overlaps = (a: string, b: string): boolean => isWithin(a, b) || isWithin(b, a)

export function registerNotesIpc({
  handle,
  repo,
  send,
  isProjectRunning,
  os = process.platform,
  watch = (dir, listener) => fsWatch(dir, listener),
  resolveKey
}: Deps): NotesIpc {
  const watches = new Map<string, Watch>()
  // Windows keeps a handle on a watched folder, so it could not be renamed or removed.
  const watchLocksFolders = os === 'win32'

  const notify = (projectId: string, entry: Watch): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      send(IPC.notesChanged, projectId)
    }, CHANGE_DEBOUNCE_MS)
  }

  const closeWatcher = (entry: Watch): void => {
    entry.watcher?.close()
    entry.watcher = null
  }

  /** Closes the watcher and drops a pending notification (unwatch, reset). */
  const stop = (entry: Watch): void => {
    closeWatcher(entry)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  /** (Re)opens the watcher on `entry.dir`; a pending notification is kept. */
  const open = (projectId: string, entry: Watch): void => {
    closeWatcher(entry)
    if (!isSafeMemoryDir(entry.dir)) {
      console.warn('[notes] refusing to watch an unsafe memory folder')
      return
    }
    try {
      mkdirSync(entry.dir, { recursive: true })
      const watcher = watch(entry.dir, () => notify(projectId, entry))
      watcher.on('error', (error) => {
        console.warn('[notes] watcher stopped', error)
        if (entry.watcher === watcher) closeWatcher(entry)
      })
      entry.watcher = watcher
    } catch (error) {
      console.warn('[notes] could not watch', error)
    }
  }

  /** Points the entry at the project's current folder; true when that folder changed. */
  const follow = (projectId: string, entry: Watch): boolean => {
    let dir: string
    try {
      dir = sync.dirOf(projectId)
    } catch (error) {
      console.warn('[notes] could not resolve memory folder', error)
      return false
    }
    if (samePath(dir, entry.dir)) return false
    entry.dir = dir
    return true
  }

  /**
   * Runs a relocation with the watchers on or around `dirs` closed (Windows only). Reopens them
   * on each project's current folder, so a moved folder is not recreated empty at its old place,
   * and tells the panels whose folder changed. Other watchers and pending notifications stay.
   */
  const unwatchedDuring = <T>(dirs: string[], op: () => T): T => {
    if (!watchLocksFolders) return op()
    const affected = [...watches].filter(
      ([, entry]) => entry.watcher && dirs.some((dir) => overlaps(entry.dir, dir))
    )
    affected.forEach(([, entry]) => closeWatcher(entry))
    try {
      return op()
    } finally {
      for (const [projectId, entry] of affected) {
        const moved = follow(projectId, entry)
        open(projectId, entry)
        if (moved) notify(projectId, entry)
      }
    }
  }

  const sync = createNotesSync({
    repo,
    isProjectRunning,
    resolveKey,
    // Watchers are only touched when a folder is really moved or merged, not on every listing.
    relocate: (fromDir, toDir, now, mode) =>
      isDirectory(fromDir)
        ? unwatchedDuring([fromDir, toDir], () => relocateMemory(fromDir, toDir, now, mode))
        : relocateMemory(fromDir, toDir, now, mode)
  })

  const dirOf = (projectId: unknown): string => {
    if (!isText(projectId)) throw new DomainError('INVALID')
    return sync.dirOf(projectId)
  }

  /** Points the project's watcher at its current folder and refreshes the panel. */
  const retarget = (projectId: string, changed: boolean): void => {
    const entry = watches.get(projectId)
    if (!entry) return
    if (follow(projectId, entry)) {
      open(projectId, entry)
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
    const existing = watches.get(projectId)
    if (existing) {
      existing.refs++
      if (follow(projectId, existing) || !existing.watcher) open(projectId, existing)
      return null
    }
    const entry: Watch = { refs: 1, dir: sync.dirOf(projectId), watcher: null, timer: null }
    watches.set(projectId, entry)
    open(projectId, entry)
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
