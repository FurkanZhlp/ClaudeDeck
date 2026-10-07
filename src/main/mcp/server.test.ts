import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/types'
import { JsonStore } from '../state/jsonStore'
import { emptyState, Repository } from '../state/repository'
import { canUseRandomPort, startMcpServer, type RunningMcpServer } from './server'
import { createSessionTokens, type SessionScope, type SessionTokens } from './sessionTokens'
import { createOptimizeTools } from './optimizeTools'
import { createTools, type Tools } from './tools'

let dir: string
let running: RunningMcpServer
let tokens: SessionTokens
let tools: Tools
let scope: SessionScope

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-mcp-server-'))
  const repo = new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts')
  )
  const { account } = repo.createAccount({ name: 'Work', color: '#000' })
  repo.createProject({ name: 'App', path: '/code/app', accountId: account.id })
  const other = repo.createAccount({ name: 'Other', color: '#111' }).account
  repo.createProject({ name: 'Hidden', path: '/code/hidden', accountId: other.id })
  const project = repo.get().projects[0]
  scope = { kind: 'session', sessionId: 'tab1', projectId: project.id, accountId: account.id }
  tools = createTools({
    repo,
    notes: { list: () => [], read: () => '', write: () => undefined },
    requestOpenSession: () => undefined,
    notifyStateChanged: () => undefined,
    confirm: () => Promise.resolve(false)
  })
  tokens = createSessionTokens()
  running = await startMcpServer({ tools, tokens, preferredPort: 0 })
})

afterAll(async () => {
  await running?.stop()
})

const post = (headers: Record<string, string>, method = 'POST'): Promise<Response> =>
  fetch(running.url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : null
  })

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  return client
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as { type: string; text: string }[])[0].text

describe('MCP server', () => {
  it('binds to loopback and exposes no token', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(Object.keys(running).sort()).toEqual(['stop', 'url'])
  })

  it('rejects requests without a valid session token', async () => {
    const token = tokens.issue(scope)
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post({ Authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
    expect((await post({ Authorization: token })).status).toBe(401)
  })

  it('rejects browser requests carrying an Origin and answers OPTIONS with 405', async () => {
    const token = tokens.issue(scope)
    const auth = { Authorization: `Bearer ${token}` }
    expect((await post({ ...auth, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ ...auth, Origin: 'null' })).status).toBe(403)
    expect((await post(auth, 'OPTIONS')).status).toBe(405)
    expect((await post(auth)).status).toBe(200)
  })

  it('serves scoped tools through the SDK client', async () => {
    const client = await connect(running.url, tokens.issue(scope))
    try {
      const { tools: listed } = await client.listTools()
      expect(listed.map((t) => t.name).sort()).toEqual([
        'create_project',
        'get_project',
        'list_accounts',
        'list_notes',
        'list_projects',
        'list_sessions',
        'open_session',
        'read_note',
        'write_note'
      ])
      const projects = await client.callTool({ name: 'list_projects', arguments: {} })
      expect(JSON.parse(textOf(projects))).toMatchObject([{ name: 'App', accountName: 'Work' }])

      const hidden = await client.callTool({ name: 'list_notes', arguments: { projectId: 'x' } })
      expect(hidden.isError).toBe(true)
      expect(textOf(hidden)).toBe('Not allowed')

      const declined = await client.callTool({
        name: 'open_session',
        arguments: { projectId: scope.projectId, kind: 'claude' }
      })
      expect(declined.isError).toBeFalsy()
      expect(textOf(declined)).toBe('The user declined.')
    } finally {
      await client.close()
    }
  })

  it('stops accepting a token once it is revoked or reissued', async () => {
    const first = tokens.issue(scope)
    expect((await post({ Authorization: `Bearer ${first}` })).status).toBe(200)
    const second = tokens.issue(scope)
    expect((await post({ Authorization: `Bearer ${first}` })).status).toBe(401)
    tokens.revoke(scope.sessionId)
    expect((await post({ Authorization: `Bearer ${second}` })).status).toBe(401)
  })

  it('rate limits tool calls per session', async () => {
    const limited = await startMcpServer({
      tools,
      tokens,
      preferredPort: 0,
      rateLimit: { limit: 2, windowMs: 60_000 }
    })
    const client = await connect(limited.url, tokens.issue(scope))
    try {
      const call = (): ReturnType<Client['callTool']> =>
        client.callTool({ name: 'list_accounts', arguments: {} })
      expect((await call()).isError).toBeFalsy()
      expect((await call()).isError).toBeFalsy()
      const third = await call()
      expect(third.isError).toBe(true)
      expect(textOf(third)).toMatch(/Rate limit/)

      // Another tab has its own budget.
      const otherClient = await connect(limited.url, tokens.issue({ ...scope, sessionId: 'tab2' }))
      try {
        const r = await otherClient.callTool({ name: 'list_accounts', arguments: {} })
        expect(r.isError).toBeFalsy()
      } finally {
        await otherClient.close()
      }
    } finally {
      await client.close()
      await limited.stop()
    }
  })
  it('shows each scope kind only its own tools', async () => {
    const both = await startMcpServer({
      tools: {
        ...tools,
        ...createOptimizeTools({
          status: () => undefined,
          findings: () => undefined,
          ask: () => Promise.resolve('Decision: skip'),
          finish: () => undefined
        })
      },
      tokens,
      preferredPort: 0
    })
    const tab = await connect(both.url, tokens.issue(scope))
    const run = await connect(
      both.url,
      tokens.issue({ kind: 'optimize', runId: 'run1', accountId: scope.accountId })
    )
    try {
      const tabTools = (await tab.listTools()).tools.map((t) => t.name)
      expect(tabTools).toContain('list_projects')
      expect(tabTools.some((n) => n.startsWith('optimize_'))).toBe(false)
      const runTools = (await run.listTools()).tools.map((t) => t.name).sort()
      expect(runTools).toEqual([
        'optimize_ask',
        'optimize_findings',
        'optimize_finish',
        'optimize_status'
      ])
      const asked = await run.callTool({
        name: 'optimize_ask',
        arguments: { id: 'q1', title: 'T', rationale: 'R', files: [] }
      })
      expect(textOf(asked)).toBe('Decision: skip')
      const refused = await run.callTool({ name: 'list_projects', arguments: {} })
      expect(refused.isError).toBe(true)
    } finally {
      await tab.close()
      await run.close()
      tokens.revoke('run1')
      await both.stop()
    }
  })
})

describe('canUseRandomPort', () => {
  const error = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  it('falls back when the preferred port is taken or reserved', () => {
    expect(canUseRandomPort(error('EADDRINUSE'), 47821)).toBe(true)
    expect(canUseRandomPort(error('EACCES'), 47821)).toBe(true)
  })

  it('rethrows other errors and failures of a random port', () => {
    expect(canUseRandomPort(error('EADDRNOTAVAIL'), 47821)).toBe(false)
    expect(canUseRandomPort(error('EACCES'), 0)).toBe(false)
    expect(canUseRandomPort(null, 47821)).toBe(false)
  })
})
