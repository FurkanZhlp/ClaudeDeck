import { readFileSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'

/** File reads of the branch lookup; tests pass fakes. */
export interface BranchFs {
  /** File text, or null when missing or unreadable. */
  read(path: string): string | null
  /** 'dir', 'file' or null when missing. */
  kind(path: string): 'dir' | 'file' | null
}

const MAX_HEAD_BYTES = 4096
const MAX_LEVELS = 64

export const nodeBranchFs: BranchFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8').slice(0, MAX_HEAD_BYTES)
    } catch {
      return null
    }
  },
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
