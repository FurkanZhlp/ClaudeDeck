import { lstatSync } from 'node:fs'
import type { Repository } from '../state/repository'
import { memoryDirForKey, resolveMemoryKey } from './memoryPath'
import { relocateMemory, type RelocateMode } from './notesStore'

export interface ProjectLocation {
  configDir: string
  path: string
}

export interface NotesSyncDeps {
  repo: Pick<Repository, 'get' | 'project' | 'account'>
  /** True while any terminal of the project is alive; its Claude may still write memory. */
  isProjectRunning: (projectId: string) => boolean
  now?: () => number
}

export type RelocateOutcome = 'none' | 'deferred' | 'moved' | 'copied'

export interface NotesSync {
  /** Memory folder the project uses right now. */
  dirOf(projectId: string): string
  /** Follows a project's account or path change; deferred while the project is running. */
  relocate(before: ProjectLocation, after: ProjectLocation, projectId: string): RelocateOutcome
  /** Applies deferred moves and pulls orphaned notes from other accounts. True if files moved. */
  prepare(projectId: string): boolean
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function createNotesSync({
  repo,
  isProjectRunning,
  now = Date.now
}: NotesSyncDeps): NotesSync {
  // Location a running project had when it was first moved; applied once it stops.
  const pending = new Map<string, ProjectLocation>()

  const current = (projectId: string): ProjectLocation => {
    const project = repo.project(projectId)
    return { configDir: repo.account(project.accountId).configDir, path: project.path }
  }

  const dirOf = (projectId: string): string => {
    const { configDir, path } = current(projectId)
    return memoryDirForKey(configDir, resolveMemoryKey(path))
  }

  /** Projects other than `exceptId` whose memory lives under `configDir` with this key. */
  const keyInUse = (
    configDir: string,
    key: string,
    exceptId: string,
    keyOf: (path: string) => string
  ): boolean => {
    const { accounts, projects } = repo.get()
    const accountIds = new Set(accounts.filter((a) => a.configDir === configDir).map((a) => a.id))
    return projects.some(
      (p) => p.id !== exceptId && accountIds.has(p.accountId) && keyOf(p.path) === key
    )
  }

  const memoKeys = (): ((path: string) => string) => {
    const cache = new Map<string, string>()
    return (path) => {
      let key = cache.get(path)
      if (key === undefined) {
        key = resolveMemoryKey(path)
        cache.set(path, key)
      }
      return key
    }
  }

  const apply = (
    before: ProjectLocation,
    after: ProjectLocation,
    projectId: string
  ): RelocateOutcome => {
    const keyOf = memoKeys()
    const beforeKey = keyOf(before.path)
    const fromDir = memoryDirForKey(before.configDir, beforeKey)
    const toDir = memoryDirForKey(after.configDir, keyOf(after.path))
    if (fromDir === toDir) return 'none'
    // Another project still reads the old folder: leave it intact and copy.
    const mode: RelocateMode = keyInUse(before.configDir, beforeKey, projectId, keyOf)
      ? 'copy'
      : 'move'
    const result = relocateMemory(fromDir, toDir, now(), mode)
    if (result.moved === 0) return 'none'
    console.info('[notes] memory relocated', { mode, ...result })
    return mode === 'copy' ? 'copied' : 'moved'
  }

  const mergeOrphans = (projectId: string): boolean => {
    const target = current(projectId)
    const keyOf = memoKeys()
    const key = keyOf(target.path)
    const toDir = memoryDirForKey(target.configDir, key)
    const seen = new Set([target.configDir])
    let changed = false
    for (const account of repo.get().accounts) {
      if (seen.has(account.configDir)) continue
      seen.add(account.configDir)
      const fromDir = memoryDirForKey(account.configDir, key)
      if (!isDirectory(fromDir)) continue
      // Notes still belong to a project of that account; never take them away.
      if (keyInUse(account.configDir, key, projectId, keyOf)) continue
      try {
        const result = relocateMemory(fromDir, toDir, now())
        if (result.moved > 0) {
          console.info('[notes] merged notes from another account', result)
          changed = true
        }
      } catch (error) {
        console.warn('[notes] could not merge notes', error)
      }
    }
    return changed
  }

  return {
    dirOf,
    relocate(before, after, projectId) {
      if (isProjectRunning(projectId)) {
        if (!pending.has(projectId)) pending.set(projectId, before)
        return 'deferred'
      }
      const from = pending.get(projectId) ?? before
      pending.delete(projectId)
      return apply(from, after, projectId)
    },
    prepare(projectId) {
      if (isProjectRunning(projectId)) return false
      let changed = false
      const before = pending.get(projectId)
      if (before) {
        pending.delete(projectId)
        try {
          changed = apply(before, current(projectId), projectId) !== 'none'
        } catch (error) {
          console.warn('[notes] deferred relocation failed', error)
        }
      }
      return mergeOrphans(projectId) || changed
    }
  }
}
