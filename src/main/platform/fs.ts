import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync, type RmOptions } from 'node:fs'
import { cp, lstat, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { COPY_TIMEOUT_MS } from './constants'
import { isWithin } from './paths'
import type { CopyRunner, OsName } from './types'

const execFileAsync = promisify(execFile)

/** APFS clone through `cp -c`; fails on other volumes or file systems. */
export const cloneCopy: CopyRunner = async (src, dest, dereference) => {
  await execFileAsync('/bin/cp', [dereference ? '-cRLp' : '-cRp', src, dest], {
    timeout: COPY_TIMEOUT_MS
  })
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined

/** Resolved form of each root; a root that cannot be resolved is kept as given. */
async function realRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(roots.map((root) => realpath(root).catch(() => root)))
}

/**
 * Where the link at `path` finally resolves, when that is inside one of `roots` (resolved);
 * null for a dangling link or one that leads elsewhere.
 */
async function linkTargetWithin(path: string, roots: readonly string[]): Promise<string | null> {
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return null
  }
  return roots.some((root) => isWithin(real, root)) ? real : null
}

/**
 * Copy filter that turns links into copies only when they lead into `roots`; dangling links and
 * links to anything outside are skipped (with a warning), so a profile can never pull in files
 * from elsewhere on the disk through a link.
 */
function linksWithin(roots: readonly string[]): (src: string) => Promise<boolean> {
  return async (src) => {
    let isLink: boolean
    try {
      isLink = (await lstat(src)).isSymbolicLink()
    } catch {
      return false
    }
    if (!isLink || (await linkTargetWithin(src, roots))) return true
    console.warn('[fs] skipped a link that is dangling or leads outside the profile', src)
    return false
  }
}

/**
 * Plain Node copy. Creating a symlink needs Developer Mode or admin rights on Windows, so a
 * verbatim copy refused with EPERM is retried with links resolved into real files; only links
 * leading into `src` or `roots` are resolved, the others are left out.
 */
export const nodeCopy: CopyRunner = async (src, dest, dereference, roots = []) => {
  const options = { recursive: true, preserveTimestamps: true, force: true } as const
  try {
    await cp(src, dest, { ...options, dereference, verbatimSymlinks: !dereference })
  } catch (error) {
    if (dereference || errorCode(error) !== 'EPERM') throw error
    await rm(dest, { recursive: true, force: true })
    const filter = linksWithin(await realRoots([src, ...roots]))
    await cp(src, dest, { ...options, dereference: true, filter })
  }
}

// ---- Retries for Windows file locks ------------------------------------------------------

/**
 * Antivirus scanners, the search indexer and open `fs.watch` handles briefly lock files on
 * Windows; these codes usually clear within a second.
 */
export const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** Waits between attempts (about 1.2 s in total). */
export const RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 350, 500]

/** Codes that may also be a real denial rather than a passing lock. */
const PERMISSION_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES'])
/** Total wait a batch of operations (a folder relocation) may spend on retries. */
export const BATCH_RETRY_BUDGET_MS = 2000

/**
 * Wait shared by the operations of one batch, so moving many locked files cannot block the
 * thread for `RETRY_DELAYS_MS` per file. Within a budget EPERM/EACCES are retried only once
 * (a lock usually clears within the first backoff; a lasting one is a real denial), EBUSY
 * keeps the full schedule until the budget is spent.
 */
export interface RetryBudget {
  remainingMs: number
}

export const retryBudget = (ms: number = BATCH_RETRY_BUDGET_MS): RetryBudget => ({
  remainingMs: ms
})

/** Wait before the next attempt, or null to give up and rethrow. */
function nextDelay(
  error: unknown,
  attempt: number,
  delays: readonly number[],
  budget?: RetryBudget
): number | null {
  const code = errorCode(error) ?? ''
  if (!RETRY_CODES.has(code) || attempt >= delays.length) return null
  if (!budget) return delays[attempt]
  if ((attempt >= 1 && PERMISSION_CODES.has(code)) || budget.remainingMs <= 0) return null
  const ms = Math.min(delays[attempt], budget.remainingMs)
  budget.remainingMs -= ms
  return ms
}

/** Blocks the thread; only used between attempts of a synchronous file operation. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const sleepAsync = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function retrySync<T>(
  op: () => T,
  sleep: (ms: number) => void = sleepSync,
  delays: readonly number[] = RETRY_DELAYS_MS,
  budget?: RetryBudget
): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op()
    } catch (error) {
      const delay = nextDelay(error, attempt, delays, budget)
      if (delay === null) throw error
      sleep(delay)
    }
  }
}

export async function retryAsync<T>(
  op: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = sleepAsync,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (error) {
      const delay = nextDelay(error, attempt, delays)
      if (delay === null) throw error
      await sleep(delay)
    }
  }
}

export interface SyncFsDeps {
  rename?: (from: string, to: string) => void
  rm?: (path: string, options?: RmOptions) => void
  sleep?: (ms: number) => void
}

export interface AsyncFsDeps {
  rename?: (from: string, to: string) => Promise<void>
  rm?: (path: string, options?: RmOptions) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

/** POSIX never needs it; Windows retries EPERM/EBUSY/EACCES. */
export function rmWithRetry(
  os: OsName,
  deps: SyncFsDeps = {}
): (path: string, options?: RmOptions) => void {
  const op = deps.rm ?? rmSync
  if (os !== 'win32') return (path, options) => op(path, options)
  return (path, options) => retrySync(() => op(path, options), deps.sleep)
}

/** Sync rename; `budget` caps the retry wait shared by a batch of renames (see RetryBudget). */
export type RenameSync = (from: string, to: string, budget?: RetryBudget) => void

/**
 * Rename for atomic writes (temp file + rename) and folder moves. POSIX rename is atomic and not
 * blocked by open handles; Windows retries EPERM/EBUSY/EACCES.
 */
export function renameWithRetry(os: OsName, deps: SyncFsDeps = {}): RenameSync {
  const op = deps.rename ?? renameSync
  if (os !== 'win32') return (from, to) => op(from, to)
  return (from, to, budget) => retrySync(() => op(from, to), deps.sleep, RETRY_DELAYS_MS, budget)
}

/**
 * Writes `file` through a uniquely named temp file next to it, so readers never see a
 * half-written file and concurrent writers never share a temp file. The temp file is removed
 * again when writing or renaming fails.
 */
export function writeFileAtomicSync(
  file: string,
  content: string,
  rename: (from: string, to: string) => void,
  mode?: number,
  /** Checked right before the rename; false leaves `file` alone and returns false. */
  beforeRename?: () => boolean
): boolean {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode })
    if (beforeRename && !beforeRename()) {
      unlinkSync(tmp)
      return false
    }
    rename(tmp, file)
    return true
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // never created, or already renamed
    }
    throw error
  }
}

/**
 * Async variants for code that already awaits its file operations. POSIX rename is atomic and
 * not blocked by open handles.
 */
export function renameWithRetryAsync(
  os: OsName,
  deps: AsyncFsDeps = {}
): (from: string, to: string) => Promise<void> {
  const op = deps.rename ?? rename
  if (os !== 'win32') return (from, to) => op(from, to)
  return (from, to) => retryAsync(() => op(from, to), deps.sleep)
}

export function rmWithRetryAsync(
  os: OsName,
  deps: AsyncFsDeps = {}
): (path: string, options?: RmOptions) => Promise<void> {
  const op = deps.rm ?? rm
  if (os !== 'win32') return (path, options) => op(path, options)
  return (path, options) => retryAsync(() => op(path, options), deps.sleep)
}

// ---- Symlinks ------------------------------------------------------------------------------

export interface SymlinkDeps {
  symlink?: (target: string, path: string, type?: 'file' | 'dir' | 'junction') => Promise<void>
  isDirectory?: (path: string) => Promise<boolean>
  copy?: (src: string, dest: string) => Promise<void>
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const copyResolved = (src: string, dest: string): Promise<void> =>
  cp(src, dest, { recursive: true, dereference: true, preserveTimestamps: true, force: true })

/**
 * Creates a link at `path` pointing to `target` (relative to the link's folder or absolute).
 * POSIX: a plain symlink. Windows: folders become junctions (no privilege needed, absolute
 * target), files a file symlink; when that is refused (EPERM without Developer Mode) the target
 * is copied instead, so the content is still there, but only when it resolves into one of
 * `roots` (the profiles involved). Anything else is skipped with a warning.
 */
export function safeSymlink(
  os: OsName,
  deps: SymlinkDeps = {}
): (target: string, path: string, roots?: readonly string[]) => Promise<void> {
  const link = deps.symlink ?? symlink
  if (os !== 'win32') return (target, path) => link(target, path)
  const isDir = deps.isDirectory ?? isDirectory
  const copy = deps.copy ?? copyResolved
  return async (target, path, roots = []) => {
    const absolute = isAbsolute(target) ? target : resolve(dirname(path), target)
    const dir = await isDir(absolute)
    try {
      await (dir ? link(absolute, path, 'junction') : link(target, path, 'file'))
    } catch (error) {
      if (errorCode(error) !== 'EPERM') throw error
      const real = await linkTargetWithin(absolute, await realRoots(roots))
      if (real === null) {
        console.warn('[fs] link not created; its target is missing or outside the profile', path)
        return
      }
      await copy(real, path)
    }
  }
}

/** APFS clones only exist on macOS; elsewhere a plain Node copy. */
export function copyRunner(os: OsName): CopyRunner {
  return os === 'darwin' ? cloneCopy : nodeCopy
}
