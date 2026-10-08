import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'

/** File reads of the branch lookup; tests pass fakes. */
export interface BranchFs {
  /** File text, or null when missing, unreadable or not a regular file. */
  read(path: string): string | null
  /** 'dir', 'file' or null when missing. */
  kind(path: string): 'dir' | 'file' | null
}

const MAX_HEAD_BYTES = 4096
const MAX_LEVELS = 64
/** Branches are cached per folder this long (a hook call per tool call reads them). */
export const BRANCH_CACHE_MS = 2000
const MAX_CACHED = 64

/**
 * Reads at most 4 KB of a regular file. Opened non-blocking, so a FIFO planted as `.git/HEAD`
 * cannot hang the read, and checked with fstat on the open descriptor before reading.
 */
export function readSmallFile(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    if (!fstatSync(fd).isFile()) return null
    const buffer = Buffer.alloc(MAX_HEAD_BYTES)
    const length = readSync(fd, buffer, 0, MAX_HEAD_BYTES, 0)
    return buffer.subarray(0, length).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

export const nodeBranchFs: BranchFs = {
  read: readSmallFile,
  kind(path) {
    try {
      const stat = statSync(path)
      return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null
    } catch {
      return null
    }
  }
}

/**
 * Branch checked out in the repository containing `cwd` (worktrees included), read from
 * `.git/HEAD` without running git. Null outside a repository or on a detached HEAD.
 */
export function readGitBranch(
  cwd: string,
  fs: BranchFs = nodeBranchFs,
  path: typeof nodePath.posix = nodePath
): string | null {
  let dir = cwd
  for (let level = 0; level < MAX_LEVELS; level++) {
    const dotGit = path.join(dir, '.git')
    const kind = fs.kind(dotGit)
    if (kind) {
      let gitDir = dotGit
      if (kind === 'file') {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.read(dotGit) ?? '')
        if (!pointer) return null
        gitDir = path.resolve(dir, pointer[1])
      }
      const head = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.read(path.join(gitDir, 'HEAD')) ?? '')
      return head ? head[1] : null
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** `readGitBranch` with a short per-folder cache. */
export function cachedGitBranch(
  read: (cwd: string) => string | null = readGitBranch,
  now: () => number = Date.now
): (cwd: string) => string | null {
  const cache = new Map<string, { at: number; branch: string | null }>()
  return (cwd) => {
    const hit = cache.get(cwd)
    const t = now()
    if (hit && t - hit.at < BRANCH_CACHE_MS) return hit.branch
    const branch = read(cwd)
    if (cache.size >= MAX_CACHED) cache.clear()
    cache.set(cwd, { at: t, branch })
    return branch
  }
}
