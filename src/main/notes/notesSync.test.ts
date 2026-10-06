import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, AppState, Project } from '../../shared/types'
import { memoryDirForKey } from './memoryPath'
import { createNotesSync, type NotesSync } from './notesSync'

let root: string
let state: { accounts: Account[]; projects: Project[] }
let running: Set<string>
let sync: NotesSync

const cfg = (id: string): string => join(root, 'accounts', id)

function repoDir(name: string, sub?: string): string {
  const dir = join(root, 'code', name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  if (sub) mkdirSync(join(dir, sub), { recursive: true })
  return sub ? join(dir, sub) : dir
}

function mem(accountId: string, key: string): string {
  return memoryDirForKey(cfg(accountId), key)
}

function seed(dir: string, content: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(content)) writeFileSync(join(dir, name), text)
}

function project(id: string, accountId: string, path: string): void {
  state.projects.push({ id, name: id, accountId, path })
}

function move(id: string, patch: Partial<Project>): ReturnType<NotesSync['relocate']> {
  const p = state.projects.find((x) => x.id === id)!
  const before = { configDir: cfg(p.accountId), path: p.path }
  Object.assign(p, patch)
  return sync.relocate(before, { configDir: cfg(p.accountId), path: p.path }, id)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudedeck-sync-')))
  state = {
    accounts: ['a', 'b', 'c'].map((id) => ({ id, name: id, color: '#000', configDir: cfg(id) })),
    projects: []
  }
  running = new Set()
  const find = <T extends { id: string }>(list: T[], id: string): T => {
    const item = list.find((x) => x.id === id)
    if (!item) throw new Error('missing')
    return item
  }
  sync = createNotesSync({
    repo: {
      get: () => state as unknown as AppState,
      project: (id) => find(state.projects, id),
      account: (id) => find(state.accounts, id)
    },
    isProjectRunning: (id) => running.has(id),
    now: () => 99
  })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('notesSync.dirOf', () => {
  it('keys a nested project folder by its git root', () => {
    const repo = repoDir('mono', 'packages/web')
    project('p', 'a', repo)
    expect(sync.dirOf('p')).toBe(mem('a', join(root, 'code', 'mono')))
  })
})

describe('notesSync.relocate', () => {
  it('moves notes to the new account', () => {
    const repo = repoDir('app')
    project('p', 'a', repo)
    seed(mem('a', repo), { 'MEMORY.md': 'm' })
    expect(move('p', { accountId: 'b' })).toBe('moved')
    expect(existsSync(mem('a', repo))).toBe(false)
    expect(readFileSync(join(mem('b', repo), 'MEMORY.md'), 'utf8')).toBe('m')
  })

  it('does nothing when the key stays the same', () => {
    const repo = repoDir('app', 'web')
    project('p', 'a', join(root, 'code', 'app'))
    seed(mem('a', join(root, 'code', 'app')), { 'MEMORY.md': 'm' })
    expect(move('p', { path: repo })).toBe('none')
    expect(readdirSync(mem('a', join(root, 'code', 'app')))).toEqual(['MEMORY.md'])
  })

  it('defers while the project runs and applies on prepare once stopped', () => {
    const repo = repoDir('app')
    project('p', 'a', repo)
    seed(mem('a', repo), { 'MEMORY.md': 'm' })
    running.add('p')
    expect(move('p', { accountId: 'b' })).toBe('deferred')
    expect(existsSync(mem('a', repo))).toBe(true)
    expect(sync.prepare('p')).toBe(false)
    expect(existsSync(mem('a', repo))).toBe(true)
    running.delete('p')
    expect(sync.prepare('p')).toBe(true)
    expect(existsSync(mem('a', repo))).toBe(false)
    expect(readFileSync(join(mem('b', repo), 'MEMORY.md'), 'utf8')).toBe('m')
  })

  it('applies a deferred path change from the first known location', () => {
    const first = repoDir('first')
    const second = repoDir('second')
    const third = repoDir('third')
    project('p', 'a', first)
    seed(mem('a', first), { 'MEMORY.md': 'm' })
    running.add('p')
    move('p', { path: second })
    move('p', { path: third })
    running.delete('p')
    sync.prepare('p')
    expect(readFileSync(join(mem('a', third), 'MEMORY.md'), 'utf8')).toBe('m')
    expect(existsSync(mem('a', second))).toBe(false)
  })

  it('copies instead of moving when another project shares the old key', () => {
    const repo = repoDir('mono', 'web')
    const api = repoDir('mono', 'api')
    project('web', 'a', repo)
    project('api', 'a', api)
    const key = join(root, 'code', 'mono')
    seed(mem('a', key), { 'MEMORY.md': 'shared' })
    expect(move('web', { accountId: 'b' })).toBe('copied')
    expect(readFileSync(join(mem('a', key), 'MEMORY.md'), 'utf8')).toBe('shared')
    expect(readFileSync(join(mem('b', key), 'MEMORY.md'), 'utf8')).toBe('shared')
  })
})

describe('notesSync.prepare', () => {
  it('merges notes left in accounts that have no project with the key', () => {
    const repo = repoDir('app')
    project('p', 'b', repo)
    seed(mem('a', repo), { 'MEMORY.md': 'from a', 'a.md': 'a' })
    seed(mem('b', repo), { 'MEMORY.md': 'mine' })
    expect(sync.prepare('p')).toBe(true)
    expect(existsSync(mem('a', repo))).toBe(false)
    expect(readdirSync(mem('b', repo)).sort()).toEqual(['MEMORY-moved-99.md', 'MEMORY.md', 'a.md'])
    expect(readFileSync(join(mem('b', repo), 'MEMORY.md'), 'utf8')).toBe('mine')
  })

  it('leaves notes of accounts that still have a project with the same key', () => {
    const web = repoDir('mono', 'web')
    const api = repoDir('mono', 'api')
    const key = join(root, 'code', 'mono')
    project('p', 'b', web)
    project('other', 'a', api)
    seed(mem('a', key), { 'MEMORY.md': 'a owns this' })
    seed(mem('c', key), { 'c.md': 'orphan' })
    expect(sync.prepare('p')).toBe(true)
    expect(readFileSync(join(mem('a', key), 'MEMORY.md'), 'utf8')).toBe('a owns this')
    expect(readdirSync(mem('b', key))).toEqual(['c.md'])
  })

  it('does not merge while the project runs', () => {
    const repo = repoDir('app')
    project('p', 'b', repo)
    seed(mem('a', repo), { 'MEMORY.md': 'from a' })
    running.add('p')
    expect(sync.prepare('p')).toBe(false)
    expect(existsSync(mem('a', repo))).toBe(true)
  })

  it('returns false when there is nothing to merge', () => {
    const repo = repoDir('app')
    project('p', 'a', repo)
    expect(sync.prepare('p')).toBe(false)
  })
})
