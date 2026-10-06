import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import { isText, type IpcTools } from '../ipcUtil'
import type { Repository } from '../state/repository'
import { memoryDir } from './memoryPath'
import { isValidNoteName, listNotes, readNote, relocateMemory } from './notesStore'

const CHANGE_DEBOUNCE_MS = 150

interface Deps {
  handle: IpcTools['handle']
  repo: Repository
  send: (channel: string, ...args: unknown[]) => void
}

interface ProjectLocation {
  configDir: string
  path: string
}

interface Watch {
  refs: number
  dir: string
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
}

export interface NotesIpc {
  /** Moves the memory folder when a project's account or path changes; re-targets watchers. */
  relocateForProjectChange(before: ProjectLocation, after: ProjectLocation): void
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

export function registerNotesIpc({ handle, repo, send }: Deps): NotesIpc {
  const watches = new Map<string, Watch>()

  const dirOf = (projectId: unknown): string => {
    if (!isText(projectId)) throw new DomainError('INVALID')
    const project = repo.project(projectId)
    return memoryDir(repo.account(project.accountId).configDir, project.path)
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

  handle(IPC.notesList, (projectId: string) => listNotes(dirOf(projectId)))
  handle(IPC.notesRead, (projectId: string, name: string) => readNote(dirOf(projectId), name))

  handle(IPC.notesOpen, (projectId: string, name: string) => {
    if (!isValidNoteName(name)) throw new DomainError('INVALID')
    const path = join(dirOf(projectId), name)
    if (!existsSync(path)) throw new DomainError('NOT_FOUND')
    return openPath(path)
  })
  handle(IPC.notesReveal, (projectId: string) => {
    const dir = dirOf(projectId)
    mkdirSync(dir, { recursive: true })
    return openPath(dir)
  })

  handle(IPC.notesWatch, (projectId: string) => {
    const dir = dirOf(projectId)
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

  return {
    relocateForProjectChange(before, after) {
      const fromDir = memoryDir(before.configDir, before.path)
      const toDir = memoryDir(after.configDir, after.path)
      if (fromDir === toDir) return
      const result = relocateMemory(fromDir, toDir)
      if (result.moved > 0) console.info('[notes] memory relocated', result)
      for (const [projectId, entry] of watches) {
        if (entry.dir !== fromDir) continue
        entry.dir = toDir
        start(projectId, entry)
        notify(projectId, entry)
      }
    },
    dispose() {
      watches.forEach(stop)
      watches.clear()
    }
  }
}
