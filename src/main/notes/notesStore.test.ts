import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../shared/errors'
import { isValidNoteName, listNotes, readNote, relocateMemory, writeNote } from './notesStore'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claudedeck-notes-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function files(dir: string, content: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(content)) writeFileSync(join(dir, name), text)
  return dir
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof DomainError ? error.code : 'OTHER'
  }
  return undefined
}

describe('listNotes', () => {
  it('returns [] for a missing folder', () => {
    expect(listNotes(join(root, 'missing'))).toEqual([])
  })

  it('lists .md files with MEMORY.md first, then by name', () => {
    const dir = files(join(root, 'm'), {
      'zeta.md': 'z',
      'MEMORY.md': 'index',
      'alpha.md': 'aa',
      'notes.txt': 'x',
      '.hidden.md': 'h'
    })
    mkdirSync(join(dir, 'sub.md'))
    const notes = listNotes(dir)
    expect(notes.map((n) => n.name)).toEqual(['MEMORY.md', 'alpha.md', 'zeta.md'])
    expect(notes[1].size).toBe(2)
    expect(notes[1].updatedAt).toBeGreaterThan(0)
  })
})

describe('note names', () => {
  it.each([
    '../x.md',
    'a/b.md',
    '..',
    '.md',
    '.secret.md',
    'a.txt',
    'a\\b.md',
    '/etc/x.md',
    'a\0.md'
  ])('rejects %s', (name) => {
    expect(isValidNoteName(name)).toBe(false)
    expect(codeOf(() => readNote(root, name))).toBe('INVALID')
    expect(codeOf(() => writeNote(root, name, 'x'))).toBe('INVALID')
  })

  it('rejects non-strings', () => {
    expect(isValidNoteName(undefined)).toBe(false)
    expect(codeOf(() => readNote(root, 42 as unknown as string))).toBe('INVALID')
  })
})

describe('readNote / writeNote', () => {
  it('throws NOT_FOUND for a missing note', () => {
    expect(codeOf(() => readNote(root, 'nope.md'))).toBe('NOT_FOUND')
  })

  it('writes atomically, creating the folder, and reads it back', () => {
    const dir = join(root, 'deep', 'memory')
    writeNote(dir, 'MEMORY.md', 'çalışma notu')
    writeNote(dir, 'MEMORY.md', 'güncel')
    expect(readNote(dir, 'MEMORY.md')).toBe('güncel')
    expect(readdirSync(dir)).toEqual(['MEMORY.md'])
  })
})

describe('relocateMemory', () => {
  it('is a no-op when the source is missing or equals the destination', () => {
    const dir = files(join(root, 'a'), { 'MEMORY.md': 'x' })
    expect(relocateMemory(join(root, 'missing'), join(root, 'b'))).toEqual({ moved: 0, renamed: 0 })
    expect(relocateMemory(dir, dir)).toEqual({ moved: 0, renamed: 0 })
    expect(existsSync(join(root, 'b'))).toBe(false)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('x')
  })

  it('renames the whole folder when the destination is missing', () => {
    const from = files(join(root, 'a', 'memory'), { 'MEMORY.md': 'm', 'x.md': 'x' })
    const to = join(root, 'cfg', 'projects', '-p', 'memory')
    expect(relocateMemory(from, to)).toEqual({ moved: 2, renamed: 0 })
    expect(existsSync(from)).toBe(false)
    expect(lstatSync(to).isDirectory()).toBe(true)
    expect(readFileSync(join(to, 'x.md'), 'utf8')).toBe('x')
  })

  it('merges into an existing destination, renaming conflicts and dropping duplicates', () => {
    const from = files(join(root, 'a'), {
      'MEMORY.md': 'source index',
      'same.md': 'identical',
      'new.md': 'new'
    })
    const to = files(join(root, 'b'), { 'MEMORY.md': 'dest index', 'same.md': 'identical' })
    expect(relocateMemory(from, to, 1234)).toEqual({ moved: 2, renamed: 1 })
    expect(readdirSync(to).sort()).toEqual([
      'MEMORY-moved-1234.md',
      'MEMORY.md',
      'new.md',
      'same.md'
    ])
    expect(readFileSync(join(to, 'MEMORY.md'), 'utf8')).toBe('dest index')
    expect(readFileSync(join(to, 'MEMORY-moved-1234.md'), 'utf8')).toBe('source index')
    expect(existsSync(from)).toBe(false)
  })

  it('picks a free name when the conflict name is taken too', () => {
    const from = files(join(root, 'a'), { 'MEMORY.md': 'src' })
    const to = files(join(root, 'b'), { 'MEMORY.md': 'dst', 'MEMORY-moved-1.md': 'older' })
    expect(relocateMemory(from, to, 1)).toEqual({ moved: 1, renamed: 1 })
    expect(readFileSync(join(to, 'MEMORY-moved-1-2.md'), 'utf8')).toBe('src')
    expect(readFileSync(join(to, 'MEMORY-moved-1.md'), 'utf8')).toBe('older')
  })

  it('keeps the source folder when something could not be moved', () => {
    const from = files(join(root, 'a'), { 'x.md': 'x' })
    mkdirSync(join(from, 'sub'))
    const to = files(join(root, 'b'), { 'MEMORY.md': 'd' })
    mkdirSync(join(to, 'sub'))
    expect(relocateMemory(from, to)).toEqual({ moved: 1, renamed: 0 })
    expect(readdirSync(from)).toEqual(['sub'])
  })

  it('leaves a symlinked source alone', () => {
    const real = files(join(root, 'real'), { 'MEMORY.md': 'm' })
    const link = join(root, 'link')
    symlinkSync(real, link)
    const to = join(root, 'b')
    expect(relocateMemory(link, to)).toEqual({ moved: 0, renamed: 0 })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readdirSync(real)).toEqual(['MEMORY.md'])
    expect(existsSync(to)).toBe(false)
  })
})
