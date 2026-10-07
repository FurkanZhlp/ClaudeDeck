import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { Account, Project, Session } from '../../shared/types'
import type { Handler } from '../ipcUtil'
import type { Repository } from '../state/repository'
import { registerAgentsIpc, type AgentsIpc } from './agentsIpc'
import { encodeProjectKey } from '../notes/memoryPath'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const SID = '11111111-2222-4333-8444-555555555555'

let root: string
let handlers: Map<string, Handler>
let send: Mock<(channel: string, ...args: unknown[]) => void>
let state: { accounts: Account[]; projects: Project[]; sessions: Session[] }
let agents: AgentsIpc

const find = <T extends { id: string }>(list: T[], id: string): T => {
  const item = list.find((x) => x.id === id)
  if (!item) throw new DomainError('NOT_FOUND')
  return item
}

const call = async (channel: string, ...args: unknown[]): Promise<unknown> =>
  handlers.get(channel)?.(...args)

const subDir = (): string =>
  join(root, 'cfg', 'projects', encodeProjectKey(join(root, 'code')), SID, 'subagents')

function writeAgent(id: string): void {
  mkdirSync(subDir(), { recursive: true })
  writeFileSync(
    join(subDir(), `agent-${id}.meta.json`),
    JSON.stringify({ agentType: 'qa', toolUseId: `toolu_${id}` })
  )
  writeFileSync(
    join(subDir(), `agent-${id}.jsonl`),
    `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } })}\n`
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cd-agents-ipc-'))
  mkdirSync(join(root, 'code'))
  state = {
    accounts: [{ id: 'acc1', name: 'A', color: '#000', configDir: join(root, 'cfg') }],
    projects: [{ id: 'p1', name: 'P', path: join(root, 'code'), accountId: 'acc1' }],
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        title: 'Claude',
        kind: 'claude',
        createdAt: 0,
        claudeSessionId: SID
      },
      { id: 's2', projectId: 'p1', title: 'Shell', kind: 'shell', createdAt: 0 },
      { id: 's3', projectId: 'p1', title: 'Fresh', kind: 'claude', createdAt: 0 }
    ]
  }
  handlers = new Map()
  send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  agents = registerAgentsIpc({
    repo: {
      session: (id: string) => find(state.sessions, id),
      project: (id: string) => find(state.projects, id),
      account: (id: string) => find(state.accounts, id)
    } as unknown as Repository,
    ipcTools: { handle: (channel, fn) => handlers.set(channel, fn) },
    getWindow: () =>
      ({ isDestroyed: () => false, webContents: { send } }) as unknown as Electron.BrowserWindow,
    watcherOptions: {
      watchFiles: false,
      timing: { resolveMs: 20, activeScanMs: 20, idleScanMs: 20, debounceMs: 10, parentPollMs: 20 }
    },
    updateDebounceMs: 10
  })
})

afterEach(() => {
  agents.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('registerAgentsIpc', () => {
  it('registers every invoke channel', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.agentsWatch,
        IPC.agentsUnwatch,
        IPC.agentsList,
        IPC.agentsOpen,
        IPC.agentsClose,
        IPC.agentsOlder
      ].sort()
    )
  })

  it('watches Claude tabs only and validates arguments', async () => {
    await expect(call(IPC.agentsWatch, 's2')).rejects.toMatchObject({ code: 'INVALID' })
    await expect(call(IPC.agentsWatch, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(IPC.agentsWatch, { path: '/etc' })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(call(IPC.agentsOpen, 's1', 'a1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await call(IPC.agentsWatch, 's1')
    await expect(call(IPC.agentsOpen, 's1', '../x')).rejects.toMatchObject({ code: 'INVALID' })
    await expect(call(IPC.agentsOlder, 's1', 'a1', 1.5)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(call(IPC.agentsOlder, 's1', 'a1', '10')).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('returns current summaries, pushes updates and stops after the last unwatch', async () => {
    writeAgent('a1')
    const first = (await call(IPC.agentsWatch, 's1')) as { agentId: string }[]
    expect(first.map((a) => a.agentId)).toEqual(['a1'])
    expect(await call(IPC.agentsWatch, 's1')).toHaveLength(1)

    writeAgent('a2')
    await vi.waitFor(
      () =>
        expect(send).toHaveBeenCalledWith(
          IPC.agentsUpdate,
          's1',
          expect.arrayContaining([expect.objectContaining({ agentId: 'a2' })])
        ),
      { timeout: 3000 }
    )
    expect(await call(IPC.agentsList, 's1')).toHaveLength(2)

    await call(IPC.agentsUnwatch, 's1')
    expect(await call(IPC.agentsList, 's1')).toHaveLength(2)
    await call(IPC.agentsUnwatch, 's1')
    expect(await call(IPC.agentsList, 's1')).toEqual([])
  })

  it('opens an agent and sends its new events', async () => {
    writeAgent('a1')
    await call(IPC.agentsWatch, 's1')
    const opened = (await call(IPC.agentsOpen, 's1', 'a1')) as {
      events: { text?: string }[]
      cursor: number | null
    }
    expect(opened.events.map((e) => e.text)).toEqual(['hi'])
    expect(opened.cursor).toBeNull()
    expect(await call(IPC.agentsOlder, 's1', 'a1', 0)).toEqual({ events: [], cursor: null })
    expect(await call(IPC.agentsClose, 's1', 'a1')).toBeNull()
  })

  it('waits for a tab without a Claude session id yet', async () => {
    expect(await call(IPC.agentsWatch, 's3')).toEqual([])
  })

  it('forgetAccount and reset release watchers', async () => {
    writeAgent('a1')
    await call(IPC.agentsWatch, 's1')
    agents.forgetAccount('other')
    expect(await call(IPC.agentsList, 's1')).toHaveLength(1)
    state.accounts = []
    agents.forgetAccount('acc1')
    expect(await call(IPC.agentsList, 's1')).toEqual([])
    agents.reset()
    await expect(call(IPC.agentsOpen, 's1', 'a1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
