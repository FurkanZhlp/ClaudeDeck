import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { DomainError } from '../../shared/errors'
import type { NoteFile } from '../../shared/types'

const INDEX_NOTE = 'MEMORY.md'
const NOTE_EXT = '.md'

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** A note name is a visible, plain basename ending in ".md"; anything else is rejected. */
export function isValidNoteName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > NOTE_EXT.length &&
    name.endsWith(NOTE_EXT) &&
    !name.startsWith('.') &&
    !/[/\\\0]/.test(name) &&
    basename(name) === name
  )
}

function notePath(dir: string, name: unknown): string {
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
    if (!entry.isFile() || !isValidNoteName(entry.name)) continue
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
  const path = notePath(dir, name)
  const stats = lstatOrNull(path)
  if (!stats?.isFile()) throw new DomainError('NOT_FOUND')
  return readFileSync(path, 'utf8')
}

export function writeNote(dir: string, name: string, content: string): void {
  const path = notePath(dir, name)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
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
function moveEntry(from: string, to: string): void {
  try {
    renameSync(from, to)
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

/**
 * Moves a project's memory folder to its new location. Merges into an existing destination
 * without overwriting: conflicting files are renamed, identical duplicates are dropped.
 */
export function relocateMemory(
  fromDir: string,
  toDir: string,
  now = Date.now()
): { moved: number; renamed: number } {
  const result = { moved: 0, renamed: 0 }
  const from = resolve(fromDir)
  const to = resolve(toDir)
  if (from === to) return result
  const fromStats = lstatOrNull(from)
  // A symlinked memory folder is the user's own setup; never follow or move it.
  if (!fromStats?.isDirectory()) return result

  if (!lstatOrNull(to)) {
    const count = readdirSync(from).length
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameSync(from, to)
      result.moved = count
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      mkdirSync(to)
    }
  }

  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    const existing = lstatOrNull(target)
    if (!existing) {
      moveEntry(source, target)
      result.moved++
      continue
    }
    // Only plain files can be compared or renamed safely; leave anything else in place.
    if (!entry.isFile() || !existing.isFile()) continue
    if (sameContent(source, target)) {
      unlinkSync(source)
      continue
    }
    moveEntry(source, join(to, freeConflictName(to, entry.name, now)))
    result.moved++
    result.renamed++
  }

  if (readdirSync(from).length === 0) rmdirSync(from)
  return result
}
