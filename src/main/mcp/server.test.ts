import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/types'
import { JsonStore } from '../state/jsonStore'
import { emptyState, Repository } from '../state/repository'
import { loadOrCreateToken, startMcpServer, type RunningMcpServer } from './server'
import { createTools } from './tools'

let dir: string
let running: RunningMcpServer

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-mcp-server-'))
  const repo = new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts')
  )
  const { account } = repo.createAccount({ name: 'Work', color: '#000' })
  repo.createProject({ name: 'App', path: '/code/app', accountId: account.id })
  const tools = createTools({
    repo,
    notes: { list: () => [], read: () => '', write: () => undefined },
    requestOpenSession: () => undefined,
    notifyStateChanged: () => undefined
  })
  running = await startMcpServer({ tools, tokenFile: join(dir, 'mcp.json'), preferredPort: 0 })
})

afterAll(async () => {
  await running?.stop()
})

const post = (headers: Record<string, string>): Promise<Response> =>
  fetch(running.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

describe('MCP server', () => {
  it('binds to loopback and persists a private token', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(running.token).toMatch(/^[0-9a-f]{64}$/)
    const file = join(dir, 'mcp.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ token: running.token })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(loadOrCreateToken(file)).toBe(running.token)
  })

  it('rejects requests without a valid bearer token', async () => {
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post({ Authorization: running.token })).status).toBe(401)
  })

  it('serves tools/list and tools/call through the SDK client', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: `Bearer ${running.token}` } }
    })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([
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
      const result = await client.callTool({ name: 'list_projects', arguments: {} })
      const content = result.content as { type: string; text: string }[]
      expect(JSON.parse(content[0].text)).toMatchObject([{ name: 'App', accountName: 'Work' }])

      const failed = await client.callTool({ name: 'get_project', arguments: { id: 'missing' } })
      expect(failed.isError).toBe(true)
    } finally {
      await client.close()
    }
  })
})
