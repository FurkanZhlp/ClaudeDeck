import { lstatSync, realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'

const MAX_ENCODED_LENGTH = 200

/** Java style String.hashCode over UTF-16 code units, as Claude Code computes it. */
function javaHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/**
 * Claude Code names per-project folders after the memory key with every non-alphanumeric as
 * "-"; names longer than 200 chars are cut and suffixed with a hash of the raw key. On Windows
 * `C:\Users\x\p` becomes `C--Users-x-p` (drive letter case kept as given).
 */
export function encodeProjectKey(keyPath: string): string {
  const encoded = keyPath.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= MAX_ENCODED_LENGTH) return encoded
  return `${encoded.slice(0, MAX_ENCODED_LENGTH)}-${Math.abs(javaHash(keyPath)).toString(36)}`
}

/** Kept for existing callers; same as encodeProjectKey. */
export const encodeProjectPath = encodeProjectKey

/** File system access of resolveMemoryKey; tests pass `path.win32` and fakes. */
export interface MemoryKeyDeps {
  path?: PlatformPath
  realpath?: (path: string) => string
  /** True when `dir` holds a `.git` entry (directory or file). */
  hasGitEntry?: (dir: string) => boolean
}

const defaultHasGitEntry =
  (p: PlatformPath) =>
  (dir: string): boolean => {
    try {
      lstatSync(p.join(dir, '.git'))
      return true
    } catch {
      return false
    }
  }

/**
 * The path Claude Code keys auto memory by: the enclosing git root (a `.git` directory or file,
 * so worktrees and submodules count), otherwise the real project path itself. The walk stops at
 * the file system root (`/`, a drive root `C:\` or a share root).
 */
export function resolveMemoryKey(projectPath: string, deps: MemoryKeyDeps = {}): string {
  const p = deps.path ?? nodePath
  const realpath = deps.realpath ?? realpathSync
  const hasGitEntry = deps.hasGitEntry ?? defaultHasGitEntry(p)
  let real: string
  try {
    real = realpath(projectPath)
  } catch {
    real = p.resolve(projectPath)
  }
  for (let dir = real; ; dir = p.dirname(dir)) {
    if (hasGitEntry(dir)) return dir
    if (p.dirname(dir) === dir) return real
  }
}

/** Memory folder for an already resolved key under an account's config dir. */
export function memoryDirForKey(
  configDir: string,
  keyPath: string,
  p: PlatformPath = nodePath
): string {
  return p.join(configDir, 'projects', encodeProjectKey(keyPath), 'memory')
}

/** Folder where Claude Code keeps auto memory for a project under an account's config dir. */
export function memoryDir(configDir: string, projectPath: string): string {
  return memoryDirForKey(configDir, resolveMemoryKey(projectPath))
}
