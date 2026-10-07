import type { FSWatcher } from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { Account, AppState, Project } from '../../shared/types'
import type { Handler } from '../ipcUtil'
import type { Repository } from '../state/repository'
import { memoryDirForKey } from './memoryPath'
import { registerNotesIpc, type NotesIpc } from './notesIpc'
import type { OsName } from '../platform/types'

vi.mock('electron', () => ({ shell: { openPath: vi.fn() }, ipcMain: { handle: vi.fn() } }))

interface FakeWatcher {
  dir: string
  fire: () => void
  close: Mock<() => void>
}

let root: string
let state: { accounts: Account[]; projects: Project[] }
let handlers: Map<string, Handler>
let watchers: FakeWatcher[]
let send: Mock<(channel: string, ...args: unknown[]) => void>
let notes: NotesIpc

const cfg = (id: string): string => join(root, 'accounts', id)
const codePath = (name: string): string => join(root, 'code', name)
const memOf = (accountId: string, name: string): string =>
  memoryDirForKey(cfg(accountId), codePath(name))

const find = <T extends { id: string }>(list: T[], id: string): T => {
  const item = list.find((x) => x.id === id)
  if (!item) throw new Error('missing')
  return item
}

function setup(os: OsName): void {
  handlers = new Map()
  watchers = []
  send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  notes = registerNotesIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    repo: {
      get: () => state as unknown as AppState,
      project: (id: string) => find(state.projects, id),
      account: (id: string) => find(state.accounts, id)
    } as unknown as Repository,
    send,
    isProjectRunning: () => false,
    os,
    resolveKey: (path) => path,
    watch: (dir, listener) => {
      const fake: FakeWatcher = { dir, fire: listener, close: vi.fn<() => void>() }
      watchers.push(fake)
      return { close: fake.close, on: vi.fn() } as unknown as FSWatcher
    }
  })
}

const call = (channel: string, ...args: unknown[]): unknown => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn(...args)
}

const watcherOf = (dir: string): FakeWatcher[] => watchers.filter((w) => w.dir === dir)

/** Moves project `id` to another account and tells the notes layer, like ipc.ts does. */
function moveToAccount(id: string, accountId: string): void {
  const project = find(state.projects, id)
  const before = { configDir: cfg(project.accountId), path: project.path }
  project.accountId = accountId
  notes.relocateForProjectChange(before, { configDir: cfg(accountId), path: project.path }, id)
}

beforeEach(() => {
  vi.useFakeTimers()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudedeck-notes-ipc-')))
  state = {
    accounts: ['a', 'b'].map((id) => ({ id, name: id, color: '#000', configDir: cfg(id) })),
    projects: [
      { id: 'one', name: 'one', accountId: 'a', path: codePath('one') },
      { id: 'two', name: 'two', accountId: 'a', path: codePath('two') }
    ]
  }
})
afterEach(() => {
  notes.dispose()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('notes watchers on Windows', () => {
  beforeEach(() => {
    setup('win32')
    call(IPC.notesWatch, 'one')
    call(IPC.notesWatch, 'two')
  })

  it('keeps every watcher and pending notification when listing needs no move', () => {
    expect(watchers.map((w) => w.dir)).toEqual([memOf('a', 'one'), memOf('a', 'two')])
    watcherOf(memOf('a', 'two'))[0].fire()

    expect(call(IPC.notesList, 'one')).toEqual([])
    call(IPC.notesWatch, 'one')
    notes.prepareProjectMemory('one')

    expect(watchers).toHaveLength(2)
    watchers.forEach((w) => expect(w.close).not.toHaveBeenCalled())
    vi.advanceTimersByTime(150)
    expect(send.mock.calls).toEqual([[IPC.notesChanged, 'two']])
  })

  it('closes and reopens only the watchers of the moved folders', () => {
    writeFileSync(join(memOf('a', 'one'), 'MEMORY.md'), 'index')
    // A change in another project is still waiting for its debounce.
    watcherOf(memOf('a', 'two'))[0].fire()

    moveToAccount('one', 'b')

    expect(readFileSync(join(memOf('b', 'one'), 'MEMORY.md'), 'utf8')).toBe('index')
    expect(existsSync(memOf('a', 'one'))).toBe(false)
    const [oldOne] = watcherOf(memOf('a', 'one'))
    expect(oldOne.close).toHaveBeenCalledTimes(1)
    expect(watcherOf(memOf('b', 'one'))).toHaveLength(1)
    expect(watcherOf(memOf('a', 'two'))[0].close).not.toHaveBeenCalled()
    expect(watchers).toHaveLength(3)

    vi.advanceTimersByTime(150)
    expect(send.mock.calls).toEqual(
      expect.arrayContaining([
        [IPC.notesChanged, 'one'],
        [IPC.notesChanged, 'two']
      ])
    )
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reports a folder change even when no note had to move', () => {
    moveToAccount('one', 'b')
    expect(watcherOf(memOf('b', 'one'))).toHaveLength(1)
    vi.advanceTimersByTime(150)
    expect(send.mock.calls).toEqual([[IPC.notesChanged, 'one']])
  })

  it('merges orphaned notes without touching unrelated watchers', () => {
    writeFileSync(join(memOf('a', 'one'), 'MEMORY.md'), 'index')
    // Project one now lives under account b; its old notes are orphans of account a.
    find(state.projects, 'one').accountId = 'b'
    expect(call(IPC.notesList, 'one')).toEqual([expect.objectContaining({ name: 'MEMORY.md' })])
    expect(watcherOf(memOf('a', 'two'))[0].close).not.toHaveBeenCalled()
    expect(watcherOf(memOf('a', 'one'))[0].close).toHaveBeenCalled()
  })
})

describe('notes watchers elsewhere', () => {
  it('keeps watchers open during a move and retargets the moved project', () => {
    setup('darwin')
    call(IPC.notesWatch, 'one')
    call(IPC.notesWatch, 'two')
    watcherOf(memOf('a', 'two'))[0].fire()
    writeFileSync(join(memOf('a', 'one'), 'MEMORY.md'), 'index')

    moveToAccount('one', 'b')

    expect(watcherOf(memOf('a', 'one'))[0].close).toHaveBeenCalledTimes(1)
    expect(watcherOf(memOf('b', 'one'))).toHaveLength(1)
    expect(watcherOf(memOf('a', 'two'))[0].close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
