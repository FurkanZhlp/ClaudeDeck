import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import * as nodePath from 'node:path'
import { basename, dirname, extname, join, resolve, type PlatformPath } from 'node:path'
import { DomainError } from '../../shared/errors'
import type { NoteFile } from '../../shared/types'
import { renameWithRetry, retryBudget, type RetryBudget } from '../platform/fs'
import { samePath } from '../platform/paths'
import type { OsName } from '../platform/types'

const INDEX_NOTE = 'MEMORY.md'
const NOTE_EXT = '.md'
/** Characters Windows refuses in file names, plus both separators. */
const FORBIDDEN_CHARS = /[<>:"|?*/\\]/
/** Codes below this are control characters, also refused by Windows. */
const FIRST_PRINTABLE = 0x20
/** Device names Windows reserves, with or without an extension (`nul.md` is `NUL`). */
const RESERVED_STEM = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i
/** Looks like a Windows 8.3 short name (`PROGRA~1`, `notes~2.md`), which may alias another file. */
const SHORT_NAME_ALIAS = /^[^.~]{1,6}~\d+(\.|$)/i

// Windows keeps handles open briefly (antivirus, indexer); retried there, plain elsewhere.
const renameFile = renameWithRetry(process.platform)

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

const hasControlChar = (name: string): boolean =>
  [...name].some((char) => char.charCodeAt(0) < FIRST_PRINTABLE)

/** A visible, plain basename ending in ".md": no separator, no NUL. */
function isPlainNoteName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > NOTE_EXT.length &&
    name.endsWith(NOTE_EXT) &&
    !name.startsWith('.') &&
    !/[/\\\0]/.test(name) &&
    basename(name) === name
  )
}

/** A plain note name that is also a valid Windows file name. */
function isWindowsNoteName(name: unknown): name is string {
  if (!isPlainNoteName(name)) return false
  const stem = name.split('.', 1)[0].trimEnd()
  return (
    !/[. ]$/.test(name) &&
    !FORBIDDEN_CHARS.test(name) &&
    !hasControlChar(name) &&
    !RESERVED_STEM.test(stem)
  )
}

/**
 * Name a note may be created or written under, on every OS so notes stay portable when a
 * project moves between machines: a valid Windows file name (no `<>:"|?*`, no control
 * characters, no reserved device name like `CON`, `NUL.md` or `com1.notes.md`, no trailing dot
 * or space) that does not look like an 8.3 short name (`NOTES~1.md` may alias another file).
 */
export function isValidNoteName(name: unknown): name is string {
  return isWindowsNoteName(name) && !SHORT_NAME_ALIAS.test(name)
}

/**
 * Name an existing note may be listed, read or opened under. Lenient outside Windows so notes
 * Claude wrote there (`Q&A: deploy.md`) stay visible; on Windows such names cannot exist, and a
 * `:` would name an alternate data stream, so the Windows file name rules apply.
 */
export function isListedNoteName(name: unknown, os: OsName = process.platform): name is string {
  return os === 'win32' ? isWindowsNoteName(name) : isPlainNoteName(name)
}

/** Real path of `path`, resolving only the part of it that exists. */
function realpathOfExisting(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * True when `path` lies strictly below `root`. On Windows `relative` returns an absolute path
 * for another drive, which is outside too.
 */
export function isInside(root: string, path: string, p: PlatformPath = nodePath): boolean {
  const rel = p.relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel)
}

/**
 * A memory dir is `<configDir>/projects/<key>/memory`. Neither it nor its key folder may be a
 * symlink, and it must resolve inside the account's `projects/` folder.
 */
export function isSafeMemoryDir(dir: string): boolean {
  const memory = resolve(dir)
  const keyDir = dirname(memory)
  const projectsDir = dirname(keyDir)
  for (const path of [memory, keyDir]) {
    const stats = lstatOrNull(path)
    if (stats && !stats.isDirectory()) return false
  }
  return isInside(realpathOfExisting(projectsDir), realpathOfExisting(memory))
}

function assertSafeMemoryDir(dir: string): void {
  if (!isSafeMemoryDir(dir)) throw new DomainError('INVALID')
}

/** Path of a note that is a regular `.md` file whose real path stays inside the memory dir. */
export function existingNotePath(dir: string, name: unknown): string {
  const path = listedNotePath(dir, name)
  const stats = lstatOrNull(path)
  if (!stats) throw new DomainError('NOT_FOUND')
  if (!stats.isFile()) throw new DomainError('INVALID')
  const real = realpathSync(path)
  if (!real.endsWith(NOTE_EXT) || !isInside(realpathSync(dir), real)) {
    throw new DomainError('INVALID')
  }
  return path
}

function listedNotePath(dir: string, name: unknown): string {
  if (!isListedNoteName(name)) throw new DomainError('INVALID')
  return join(dir, name)
}

function writableNotePath(dir: string, name: unknown): string {
  if (!isValidNoteName(name)) throw new DomainError('INVALID')
  return join(dir, name)
}

export function listNotes(dir: string): NoteFile[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const notes: NoteFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isListedNoteName(entry.name)) continue
    const stats = lstatOrNull(join(dir, entry.name))
    if (stats) notes.push({ name: entry.name, updatedAt: stats.mtimeMs, size: stats.size })
  }
  return notes.sort((a, b) => {
    if (a.name === INDEX_NOTE) return -1
    if (b.name === INDEX_NOTE) return 1
    return a.name.localeCompare(b.name)
  })
}

export function readNote(dir: string, name: string): string {
  const path = listedNotePath(dir, name)
  const stats = lstatOrNull(path)
  if (!stats?.isFile()) throw new DomainError('NOT_FOUND')
  return readFileSync(path, 'utf8')
}

export function writeNote(dir: string, name: string, content: string): void {
  const path = writableNotePath(dir, name)
  assertSafeMemoryDir(dir)
  const existing = lstatOrNull(path)
  if (existing && !existing.isFile()) throw new DomainError('INVALID')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameFile(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp was never created or already renamed
    }
    throw error
  }
}

/** rename, falling back to copy + unlink for files when crossing volumes. */
function moveEntry(from: string, to: string, budget: RetryBudget): void {
  try {
    renameFile(from, to, budget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV' || !statSync(from).isFile()) throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function sameContent(a: string, b: string): boolean {
  const sa = statSync(a)
  const sb = statSync(b)
  return sa.size === sb.size && readFileSync(a).equals(readFileSync(b))
}

function freeConflictName(toDir: string, name: string, now: number): string {
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = `${base}-moved-${now}${ext}`
  for (let i = 2; lstatOrNull(join(toDir, candidate)); i++) {
    candidate = `${base}-moved-${now}-${i}${ext}`
  }
  return candidate
}

export type RelocateMode = 'move' | 'copy'

/**
 * Moves (or copies, leaving the source intact) a project's memory folder to its new location.
 * Merges into an existing destination without overwriting: conflicting files are renamed,
 * identical duplicates are dropped. Throws INVALID when either side is not a safe memory dir.
 */
export function relocateMemory(
  fromDir: string,
  toDir: string,
  now = Date.now(),
  mode: RelocateMode = 'move'
): { moved: number; renamed: number } {
  const result = { moved: 0, renamed: 0 }
  const from = resolve(fromDir)
  const to = resolve(toDir)
  if (samePath(from, to)) return result
  const fromStats = lstatOrNull(from)
  // A symlinked memory folder is the user's own setup; never follow or move it.
  if (!fromStats?.isDirectory()) return result
  assertSafeMemoryDir(from)
  assertSafeMemoryDir(to)
  const copy = mode === 'copy'
  // One retry budget for the whole folder: locked files must not block the thread per file.
  const budget = retryBudget()

  if (!copy && !lstatOrNull(to)) {
    const count = readdirSync(from).length
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameFile(from, to, budget)
      result.moved = count
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
  }
  mkdirSync(to, { recursive: true })

  const transfer = (source: string, target: string): void =>
    copy ? copyFileSync(source, target) : moveEntry(source, target, budget)

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    // Copies only carry plain files; moves carry everything that has no counterpart.
    if (copy && !entry.isFile()) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    const existing = lstatOrNull(target)
    if (!existing) {
      transfer(source, target)
      result.moved++
      continue
    }
    // Only plain files can be compared or renamed safely; leave anything else in place.
    if (!entry.isFile() || !existing.isFile()) continue
    if (sameContent(source, target)) {
      if (!copy) unlinkSync(source)
      continue
    }
    transfer(source, join(to, freeConflictName(to, entry.name, now)))
    result.moved++
    result.renamed++
  }

  if (!copy && readdirSync(from).length === 0) rmdirSync(from)
  return result
}
