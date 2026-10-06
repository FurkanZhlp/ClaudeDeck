import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { AppState, NoteFile } from '../../shared/types'
import { memoryDir } from '../notes/memoryPath'
import { JsonStore } from '../state/jsonStore'
import { emptyState, Repository } from '../state/repository'
import type { McpScope } from './sessionTokens'
import {
  createTools,
  findProjectByPath,
  type ConfirmRequest,
  type ToolResult,
  type Tools
} from './tools'

let dir: string
let repo: Repository
let files: Map<string, string>
let tools: Tools
const notifyStateChanged = vi.fn()
const requestOpenSession = vi.fn()
const confirm = vi.fn<(req: ConfirmRequest) => Promise<boolean>>()

// Account id1 owns projects id2 (App) and id3 (Web); account id4 owns project id5 (Secret).
const scope: McpScope = { sessionId: 's1', projectId: 'id2', accountId: 'id1' }

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
const NOT_ALLOWED = { isError: true, content: [{ text: 'Not allowed' }] }
const DECLINED = { content: [{ text: 'The user declined.' }] }

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
  confirm.mockReset()
  confirm.mockResolvedValue(true)
  tools = createTools({ repo, notes, notifyStateChanged, requestOpenSession, confirm })
  repo.createAccount({ name: 'Work', color: '#000' })
  repo.updateAccount('id1', { email: 'a@b.c' })
  repo.createProject({ name: 'App', path: '/code/app', accountId: 'id1' })
  repo.createProject({ name: 'Web', path: '/code/app/web', accountId: 'id1' })
  repo.createAccount({ name: 'Private', color: '#111' })
  repo.createProject({ name: 'Secret', path: '/code/secret', accountId: 'id4' })
})

describe('MCP tools: reading', () => {
  it('lists only the caller account, without its email', async () => {
    expect(data(await tools.list_accounts.call({}, scope))).toEqual([{ id: 'id1', name: 'Work' }])
  })

  it('lists only the projects of the caller account', async () => {
    expect(data(await tools.list_projects.call(undefined, scope))).toEqual([
      { id: 'id2', name: 'App', path: '/code/app', accountId: 'id1', accountName: 'Work' },
      { id: 'id3', name: 'Web', path: '/code/app/web', accountId: 'id1', accountName: 'Work' }
    ])
    const other = { sessionId: 's9', projectId: 'id5', accountId: 'id4' }
    expect(data(await tools.list_projects.call({}, other))).toMatchObject([{ id: 'id5' }])
  })

  it('finds a project by id or by the deepest folder containing a path', async () => {
    const get = (args: unknown): Promise<ToolResult> => tools.get_project.call(args, scope)
    expect(data(await get({ id: 'id2' }))).toMatchObject({ name: 'App' })
    expect(data(await get({ path: '/code/app/web/src' }))).toMatchObject({ id: 'id3' })
    expect(data(await get({ path: '/code/app/' }))).toMatchObject({ id: 'id2' })
    expect(findProjectByPath(repo.get().projects, '/code/application')).toBeUndefined()
    const missing = await get({ path: '/elsewhere' })
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'Not found' }] })
    expect((await get({})).isError).toBe(true)
    expect((await get({ path: 'relative' })).isError).toBe(true)
  })

  it('hides projects of other accounts from get_project', async () => {
    expect(await tools.get_project.call({ id: 'id5' }, scope)).toMatchObject(NOT_ALLOWED)
    expect(await tools.get_project.call({ id: 'missing' }, scope)).toMatchObject(NOT_ALLOWED)
    const byPath = await tools.get_project.call({ path: '/code/secret/x' }, scope)
    expect(byPath).toMatchObject({ isError: true, content: [{ text: 'Not found' }] })
  })

  it('lists sessions of the own project only', async () => {
    repo.createSession('id2', 'claude', 'Mine')
    repo.createSession('id3', 'claude', 'Sibling')
    expect(data(await tools.list_sessions.call({}, scope))).toMatchObject([{ title: 'Mine' }])
    expect(await tools.list_sessions.call({ projectId: 'id3' }, scope)).toMatchObject(NOT_ALLOWED)
    expect(await tools.list_sessions.call({ projectId: 'id5' }, scope)).toMatchObject(NOT_ALLOWED)
  })
})

describe('MCP tools: notes', () => {
  const mem = (): string => memoryDir(join(dir, 'accounts', 'id1'), '/code/app')

  it('reads and writes notes of the own project, by default or by explicit id', async () => {
    const w = await tools.write_note.call({ name: 'MEMORY.md', content: 'hi' }, scope)
    expect(w.isError).toBeUndefined()
    expect(files.get(`${mem()}/MEMORY.md`)).toBe('hi')
    expect(data(await tools.list_notes.call({}, scope))).toEqual([
      { name: 'MEMORY.md', updatedAt: 1, size: 2 }
    ])
    const read = await tools.read_note.call({ projectId: 'id2', name: 'MEMORY.md' }, scope)
    expect(data(read)).toEqual({ name: 'MEMORY.md', content: 'hi' })
    expect((await tools.read_note.call({ name: 'x.md' }, scope)).isError).toBe(true)
  })

  it('refuses notes of other projects and accounts', async () => {
    const secretDir = memoryDir(join(dir, 'accounts', 'id4'), '/code/secret')
    files.set(`${secretDir}/MEMORY.md`, 'secret')
    for (const projectId of ['id3', 'id5']) {
      expect(await tools.list_notes.call({ projectId }, scope)).toMatchObject(NOT_ALLOWED)
      const read = await tools.read_note.call({ projectId, name: 'MEMORY.md' }, scope)
      expect(read).toMatchObject(NOT_ALLOWED)
      const write = await tools.write_note.call(
        { projectId, name: 'MEMORY.md', content: 'planted' },
        scope
      )
      expect(write).toMatchObject(NOT_ALLOWED)
    }
    expect(files.get(`${secretDir}/MEMORY.md`)).toBe('secret')
    expect(files.size).toBe(1)
  })

  it('rejects note names that escape the folder', async () => {
    for (const name of ['../x.md', 'a/b.md', '..', '']) {
      const r = await tools.write_note.call({ name, content: 'x' }, scope)
      expect(r.isError).toBe(true)
    }
    expect(files.size).toBe(0)
  })

  it('enforces the per-project note count and size quota', async () => {
    for (let i = 0; i < 200; i++) files.set(`${mem()}/n${i}.md`, 'x')
    const tooMany = await tools.write_note.call({ name: 'new.md', content: 'x' }, scope)
    expect(tooMany.isError).toBe(true)
    const overwrite = await tools.write_note.call({ name: 'n0.md', content: 'y' }, scope)
    expect(overwrite.isError).toBeUndefined()

    files.clear()
    const mb = 1024 * 1024
    for (let i = 0; i < 4; i++) files.set(`${mem()}/big${i}.md`, 'x'.repeat(mb))
    const fits = await tools.write_note.call({ name: 'a.md', content: 'x'.repeat(mb) }, scope)
    expect(fits.isError).toBeUndefined()
    const over = await tools.write_note.call({ name: 'b.md', content: 'x' }, scope)
    expect(over).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('5 MB') }]
    })
  })
})

describe('MCP tools: create_project', () => {
  it('asks the user, then creates the project at the real path', async () => {
    const folder = join(dir, 'new')
    mkdirSync(folder)
    const link = join(dir, 'link')
    symlinkSync(folder, link)
    const r = await tools.create_project.call({ name: 'New', path: link }, scope)
    const real = realpathSync(folder)
    expect(confirm).toHaveBeenCalledWith({
      kind: 'create_project',
      name: 'New',
      path: real,
      accountId: 'id1',
      requestedBy: scope
    })
    expect(data(r)).toMatchObject({ name: 'New', path: real, accountId: 'id1' })
    expect(repo.get().projects).toHaveLength(4)
    expect(notifyStateChanged).toHaveBeenCalledOnce()
  })

  it('creates nothing when the user declines or the confirmation fails', async () => {
    confirm.mockResolvedValueOnce(false)
    expect(await tools.create_project.call({ name: 'N', path: dir }, scope)).toMatchObject(DECLINED)
    confirm.mockRejectedValueOnce(new Error('window closed'))
    expect(await tools.create_project.call({ name: 'N', path: dir }, scope)).toMatchObject(DECLINED)
    expect(repo.get().projects).toHaveLength(3)
    expect(notifyStateChanged).not.toHaveBeenCalled()
  })

  it('treats an unanswered confirmation as declined', async () => {
    const slow = createTools({
      repo,
      notes,
      notifyStateChanged,
      requestOpenSession,
      confirm: () => new Promise(() => undefined),
      confirmTimeoutMs: 10
    })
    expect(await slow.create_project.call({ name: 'N', path: dir }, scope)).toMatchObject(DECLINED)
  })

  it('refuses another account and invalid folders without asking', async () => {
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x')
    const cases: [Record<string, string>, string][] = [
      [{ name: 'X', path: dir, accountId: 'id4' }, 'Not allowed'],
      [{ name: 'X', path: join(dir, 'missing') }, 'Path does not exist'],
      [{ name: 'X', path: file }, 'Path is not a directory'],
      [{ name: 'X', path: '/' }, 'Path not allowed'],
      [{ name: 'X', path: homedir() }, 'Path not allowed'],
      [{ name: 'X', path: '/usr/bin' }, 'Path not allowed'],
      [{ name: 'X', path: '/etc' }, 'Path not allowed'],
      [{ name: 'X', path: '/System' }, 'Path not allowed']
    ]
    for (const [args, message] of cases) {
      const r = await tools.create_project.call(args, scope)
      expect(r, args.path).toMatchObject({ isError: true, content: [{ text: message }] })
    }
    expect((await tools.create_project.call({ name: 'X', path: 'rel' }, scope)).isError).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(repo.get().projects).toHaveLength(3)
  })

  it('accepts its own account id', async () => {
    const r = await tools.create_project.call({ name: 'N', path: dir, accountId: 'id1' }, scope)
    expect(r.isError).toBeUndefined()
  })
})

describe('MCP tools: open_session', () => {
  it('asks the user, then creates the tab and asks the UI to show it', async () => {
    const first = data(await tools.open_session.call({ projectId: 'id2', kind: 'claude' }, scope))
    expect(first).toEqual({ id: 'id6', title: 'Claude 1', kind: 'claude' })
    expect(confirm).toHaveBeenCalledWith({
      kind: 'open_session',
      projectId: 'id2',
      sessionKind: 'claude',
      title: 'Claude 1',
      requestedBy: scope
    })
    expect(requestOpenSession).toHaveBeenLastCalledWith('id6')
    const shell = await tools.open_session.call({ projectId: 'id3', kind: 'shell' }, scope)
    expect(data(shell)).toMatchObject({ title: 'Terminal 1' })
    const named = await tools.open_session.call(
      { projectId: 'id2', kind: 'claude', title: ' Fix ' },
      scope
    )
    expect(data(named)).toMatchObject({ title: 'Fix' })
    expect(notifyStateChanged).toHaveBeenCalledTimes(3)
  })

  it('does nothing when the user declines', async () => {
    confirm.mockResolvedValueOnce(false)
    const r = await tools.open_session.call({ projectId: 'id2', kind: 'claude' }, scope)
    expect(r).toMatchObject(DECLINED)
    expect(r.isError).toBeUndefined()
    expect(repo.get().sessions).toHaveLength(0)
    expect(requestOpenSession).not.toHaveBeenCalled()
  })

  it('refuses projects of other accounts without asking', async () => {
    const r = await tools.open_session.call({ projectId: 'id5', kind: 'claude' }, scope)
    expect(r).toMatchObject(NOT_ALLOWED)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('allows only one pending confirmation per tab', async () => {
    let answer: (v: boolean) => void = () => undefined
    confirm.mockImplementationOnce(() => new Promise((done) => (answer = done)))
    const first = tools.open_session.call({ projectId: 'id2', kind: 'claude' }, scope)
    const second = await tools.open_session.call({ projectId: 'id2', kind: 'claude' }, scope)
    expect(second.isError).toBe(true)
    answer(true)
    expect((await first).isError).toBeUndefined()
    expect(repo.get().sessions).toHaveLength(1)
  })

  it('validates input without touching state', async () => {
    const r = await tools.open_session.call({ projectId: 'id2', kind: 'zsh' }, scope)
    expect(r.isError).toBe(true)
    expect((await tools.list_sessions.call({ projectId: 'id2', extra: 1 }, scope)).isError).toBe(
      true
    )
    expect(repo.get().sessions).toHaveLength(0)
    expect(confirm).not.toHaveBeenCalled()
  })
})
