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
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../shared/errors'
import {
  existingNotePath,
  isInside,
  isListedNoteName,
  isSafeMemoryDir,
  isValidNoteName,
  listNotes,
  readNote,
  relocateMemory,
  writeNote
} from './notesStore'
import { isWindows, posixOnly } from '../../test/platform'

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
    'a\0.md',
    'a.md.',
    'a.md '
  ])('rejects %s everywhere', (name) => {
    expect(isValidNoteName(name)).toBe(false)
    expect(isListedNoteName(name, 'darwin')).toBe(false)
    expect(isListedNoteName(name, 'win32')).toBe(false)
    expect(codeOf(() => readNote(root, name))).toBe('INVALID')
    expect(codeOf(() => writeNote(root, name, 'x'))).toBe('INVALID')
  })

  it.each([
    'a:b.md',
    'what?.md',
    'star*.md',
    'pipe|.md',
    'quote".md',
    '<tag>.md',
    'tab\t.md',
    'line\n.md',
    'esc\u001b.md',
    'CON.md',
    'con.md',
    'Nul.md',
    'aux.notes.md',
    'prn .md',
    'COM1.md',
    'lpt9.md',
    'com¹.md',
    'CONIN$.md',
    'PROGRA~1.md',
    'notes~2.md',
    'AB~10',
    'x~1.backup.md'
  ])('refuses to write %s, lists it only outside Windows', (name) => {
    expect(isValidNoteName(name)).toBe(false)
    expect(codeOf(() => writeNote(root, name, 'x'))).toBe('INVALID')
    const shortName = /~\d/.test(name)
    expect(isListedNoteName(name, 'win32')).toBe(shortName && name.endsWith('.md'))
    expect(isListedNoteName(name, 'darwin')).toBe(name.endsWith('.md'))
    if (!isWindows)
      expect(codeOf(() => readNote(root, name))).toBe(
        name.endsWith('.md') ? 'NOT_FOUND' : 'INVALID'
      )
  })

  it.each([
    'MEMORY.md',
    'notes v2.md',
    'console.md',
    'com10.md',
    'lpt.md',
    'çalışma notu.md',
    'a.b.md',
    'my~notes.md',
    'long-name~1.md'
  ])('accepts %s', (name) => {
    expect(isValidNoteName(name)).toBe(true)
    expect(isListedNoteName(name, 'darwin')).toBe(true)
    expect(isListedNoteName(name, 'win32')).toBe(true)
  })

  // A colon cannot be part of a Windows file name (it would name an alternate data stream).
  posixOnly('keeps existing notes with non-portable names visible and readable', () => {
    const name = 'Q&A: deploy.md'
    const dir = files(join(root, 'm'), { [name]: 'answers' })
    expect(listNotes(dir).map((n) => n.name)).toEqual([name])
    expect(readNote(dir, name)).toBe('answers')
    expect(codeOf(() => writeNote(dir, name, 'x'))).toBe('INVALID')
  })

  it('rejects non-strings', () => {
    expect(isValidNoteName(undefined)).toBe(false)
    expect(codeOf(() => readNote(root, 42 as unknown as string))).toBe('INVALID')
  })
})

describe('isInside', () => {
  it('needs a path strictly below the root', () => {
    expect(isInside('/a/projects', '/a/projects/k/memory', posix)).toBe(true)
    expect(isInside('/a/projects', '/a/projects', posix)).toBe(false)
    expect(isInside('/a/projects', '/a/projects-x/k', posix)).toBe(false)
    expect(isInside('/a/projects', '/a', posix)).toBe(false)
  })

  it('treats another Windows drive as outside', () => {
    expect(isInside('C:\\cfg\\projects', 'C:\\cfg\\projects\\k\\memory', win32)).toBe(true)
    expect(isInside('C:\\cfg\\projects', 'D:\\cfg\\projects\\k\\memory', win32)).toBe(false)
    expect(isInside('C:\\cfg\\projects', 'D:\\', win32)).toBe(false)
    expect(isInside('C:\\cfg\\projects', 'C:\\cfg', win32)).toBe(false)
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

describe('relocateMemory copy mode', () => {
  it('copies into a missing destination and keeps the source', () => {
    const from = files(join(root, 'cfg', 'projects', '-a', 'memory'), { 'MEMORY.md': 'm' })
    const to = join(root, 'cfg2', 'projects', '-a', 'memory')
    expect(relocateMemory(from, to, 1, 'copy')).toEqual({ moved: 1, renamed: 0 })
    expect(readFileSync(join(from, 'MEMORY.md'), 'utf8')).toBe('m')
    expect(readFileSync(join(to, 'MEMORY.md'), 'utf8')).toBe('m')
  })

  it('merges into an existing destination without touching the source', () => {
    const from = files(join(root, 'a'), { 'MEMORY.md': 'src', 'same.md': 's' })
    const to = files(join(root, 'b'), { 'MEMORY.md': 'dst', 'same.md': 's' })
    expect(relocateMemory(from, to, 7, 'copy')).toEqual({ moved: 1, renamed: 1 })
    expect(readdirSync(from).sort()).toEqual(['MEMORY.md', 'same.md'])
    expect(readFileSync(join(to, 'MEMORY-moved-7.md'), 'utf8')).toBe('src')
  })
})

describe('symlink hardening', () => {
  function projectsDir(): string {
    const dir = join(root, 'cfg', 'projects')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('accepts a regular memory folder inside projects/', () => {
    expect(isSafeMemoryDir(join(projectsDir(), '-p', 'memory'))).toBe(true)
  })

  it('refuses to write through a symlinked memory folder', () => {
    const outside = files(join(root, 'outside'), {})
    mkdirSync(join(projectsDir(), '-p'))
    const memory = join(projectsDir(), '-p', 'memory')
    symlinkSync(outside, memory)
    expect(isSafeMemoryDir(memory)).toBe(false)
    expect(codeOf(() => writeNote(memory, 'MEMORY.md', 'x'))).toBe('INVALID')
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses a symlinked key folder that points outside projects/', () => {
    const outside = files(join(root, 'outside'), {})
    symlinkSync(outside, join(projectsDir(), '-p'))
    const memory = join(projectsDir(), '-p', 'memory')
    expect(codeOf(() => writeNote(memory, 'MEMORY.md', 'x'))).toBe('INVALID')
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses to replace a note that is not a regular file', () => {
    const memory = files(join(projectsDir(), '-p', 'memory'), {})
    symlinkSync(join(root, 'elsewhere.md'), join(memory, 'MEMORY.md'))
    expect(codeOf(() => writeNote(memory, 'MEMORY.md', 'x'))).toBe('INVALID')
    expect(existsSync(join(root, 'elsewhere.md'))).toBe(false)
  })

  it('refuses to relocate into a symlinked destination', () => {
    const from = files(join(projectsDir(), '-a', 'memory'), { 'MEMORY.md': 'm' })
    const outside = files(join(root, 'outside'), {})
    mkdirSync(join(projectsDir(), '-b'))
    const to = join(projectsDir(), '-b', 'memory')
    symlinkSync(outside, to)
    expect(codeOf(() => relocateMemory(from, to))).toBe('INVALID')
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(from)).toEqual(['MEMORY.md'])
  })

  it('opens only regular .md files that stay inside the memory folder', () => {
    const memory = files(join(projectsDir(), '-p', 'memory'), { 'MEMORY.md': 'm' })
    const secret = files(join(root, 'outside'), { 'secret.md': 's', 'run.command': 'x' })
    symlinkSync(join(secret, 'secret.md'), join(memory, 'leak.md'))
    symlinkSync(join(secret, 'run.command'), join(memory, 'run.md'))
    mkdirSync(join(memory, 'dir.md'))
    expect(existingNotePath(memory, 'MEMORY.md')).toBe(join(memory, 'MEMORY.md'))
    expect(codeOf(() => existingNotePath(memory, 'leak.md'))).toBe('INVALID')
    expect(codeOf(() => existingNotePath(memory, 'run.md'))).toBe('INVALID')
    expect(codeOf(() => existingNotePath(memory, 'dir.md'))).toBe('INVALID')
    expect(codeOf(() => existingNotePath(memory, 'missing.md'))).toBe('NOT_FOUND')
    expect(codeOf(() => existingNotePath(memory, '../x.md'))).toBe('INVALID')
  })
})
