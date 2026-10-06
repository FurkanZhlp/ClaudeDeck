import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { AppState, NoteFile } from '../../shared/types'
import { memoryDir } from '../notes/memoryPath'
import { JsonStore } from '../state/jsonStore'
import { emptyState, Repository } from '../state/repository'
import { createTools, findProjectByPath, type ToolResult, type Tools } from './tools'

let dir: string
let repo: Repository
let files: Map<string, string>
let tools: Tools
const notifyStateChanged = vi.fn()
const requestOpenSession = vi.fn()

const notes = {
  list: (d: string): NoteFile[] =>
    [...files.entries()]
      .filter(([k]) => k.startsWith(`${d}/`))
      .map(([k, v]) => ({ name: k.slice(d.length + 1), updatedAt: 1, size: v.length })),
  read: (d: string, name: string): string => {
    const value = files.get(`${d}/${name}`)
    if (value === undefined) throw new DomainError('NOT_FOUND')
    return value
  },
  write: (d: string, name: string, content: string): void => {
    files.set(`${d}/${name}`, content)
  }
}

const data = (r: ToolResult): unknown => JSON.parse(r.content[0].text)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-mcp-tools-'))
  let n = 0
  repo = new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts'),
    () => `id${++n}`
  )
  files = new Map()
  notifyStateChanged.mockClear()
  requestOpenSession.mockClear()
  tools = createTools({ repo, notes, notifyStateChanged, requestOpenSession })
  repo.createAccount({ name: 'Work', color: '#000' })
  repo.updateAccount('id1', { email: 'a@b.c' })
  repo.createProject({ name: 'App', path: '/code/app', accountId: 'id1' })
  repo.createProject({ name: 'Web', path: '/code/app/web', accountId: 'id1' })
})

describe('MCP tools', () => {
  it('lists accounts and projects', async () => {
    expect(data(await tools.list_accounts.call({}))).toEqual([
      { id: 'id1', name: 'Work', email: 'a@b.c' }
    ])
    expect(data(await tools.list_projects.call(undefined))).toEqual([
      { id: 'id2', name: 'App', path: '/code/app', accountId: 'id1', accountName: 'Work' },
      { id: 'id3', name: 'Web', path: '/code/app/web', accountId: 'id1', accountName: 'Work' }
    ])
  })

  it('finds a project by id or by the deepest folder containing a path', async () => {
    expect(data(await tools.get_project.call({ id: 'id2' }))).toMatchObject({ name: 'App' })
    expect(data(await tools.get_project.call({ path: '/code/app/web/src' }))).toMatchObject({
      id: 'id3'
    })
    expect(data(await tools.get_project.call({ path: '/code/app/' }))).toMatchObject({ id: 'id2' })
    expect(findProjectByPath(repo.get().projects, '/code/application')).toBeUndefined()
    const missing = await tools.get_project.call({ path: '/elsewhere' })
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'Not found' }] })
    expect((await tools.get_project.call({})).isError).toBe(true)
    expect((await tools.get_project.call({ path: 'relative' })).isError).toBe(true)
  })

  it('reads and writes notes in the project memory folder', async () => {
    const mem = memoryDir(join(dir, 'accounts', 'id1'), '/code/app')
    const w = await tools.write_note.call({ projectId: 'id2', name: 'MEMORY.md', content: 'hi' })
    expect(w.isError).toBeUndefined()
    expect(files.get(`${mem}/MEMORY.md`)).toBe('hi')
    expect(data(await tools.list_notes.call({ projectId: 'id2' }))).toEqual([
      { name: 'MEMORY.md', updatedAt: 1, size: 2 }
    ])
    expect(data(await tools.read_note.call({ projectId: 'id2', name: 'MEMORY.md' }))).toEqual({
      name: 'MEMORY.md',
      content: 'hi'
    })
    expect((await tools.read_note.call({ projectId: 'id2', name: 'x.md' })).isError).toBe(true)
  })

  it('rejects note names that escape the folder', async () => {
    for (const name of ['../x.md', 'a/b.md', '..', '']) {
      const r = await tools.write_note.call({ projectId: 'id2', name, content: 'x' })
      expect(r.isError).toBe(true)
    }
    expect(files.size).toBe(0)
  })

  it('creates a project and notifies the UI', async () => {
    const r = await tools.create_project.call({ name: 'New', path: '/code/new', accountId: 'id1' })
    expect(data(r)).toMatchObject({ id: 'id4', name: 'New', accountName: 'Work' })
    expect(repo.get().projects).toHaveLength(3)
    expect(notifyStateChanged).toHaveBeenCalledOnce()

    const bad = await tools.create_project.call({ name: 'X', path: '/x', accountId: 'nope' })
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'Not found' }] })
  })

  it('opens sessions with numbered default titles and asks the UI to open them', async () => {
    const first = data(await tools.open_session.call({ projectId: 'id2', kind: 'claude' }))
    expect(first).toEqual({ id: 'id4', title: 'Claude 1', kind: 'claude' })
    await tools.open_session.call({ projectId: 'id2', kind: 'claude' })
    const shell = data(await tools.open_session.call({ projectId: 'id2', kind: 'shell' }))
    expect(shell).toMatchObject({ title: 'Terminal 1' })
    const named = data(
      await tools.open_session.call({ projectId: 'id2', kind: 'claude', title: ' Fix ' })
    )
    expect(named).toMatchObject({ title: 'Fix' })
    expect(requestOpenSession).toHaveBeenLastCalledWith('id7')
    expect(notifyStateChanged).toHaveBeenCalledTimes(4)
    expect(data(await tools.list_sessions.call({ projectId: 'id2' }))).toHaveLength(4)
  })

  it('validates input without touching state', async () => {
    const r = await tools.open_session.call({ projectId: 'id2', kind: 'zsh' })
    expect(r.isError).toBe(true)
    expect((await tools.list_sessions.call({ projectId: 'id2', extra: 1 })).isError).toBe(true)
    expect(repo.get().sessions).toHaveLength(0)
    expect(requestOpenSession).not.toHaveBeenCalled()
  })
})
