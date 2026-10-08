import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../shared/types'
import { JsonStore } from '../state/jsonStore'
import { emptyState, Repository } from '../state/repository'
import {
  canUseRandomPort,
  configureTimeouts,
  IDLE_TIMEOUT_MS,
  startMcpServer,
  type RouteScope,
  type RunningMcpServer
} from './server'
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
        'cancel_test_run',
        'create_project',
        'get_project',
        'get_test_queue',
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

describe('hook routes', () => {
  const PRE = '/hooks/test-queue/pre'
  let hooks: RunningMcpServer
  let base: string
  let calls: { scope: RouteScope; payload: unknown; signal: AbortSignal }[]
  let release: ((body: string) => void) | null = null
  const finish = (body: string): void => {
    const done = release as ((body: string) => void) | null
    done?.(body)
  }

  beforeAll(async () => {
    hooks = await startMcpServer({
      tools,
      tokens,
      preferredPort: 0,
      routeRateLimit: { limit: 5, windowMs: 60_000 },
      maxRouteRequests: 2,
      routes: {
        [PRE]: {
          maxBodyBytes: 1024,
          handle: (s, payload, signal) => {
            calls.push({ scope: s, payload, signal })
            if ((payload as { wait?: boolean } | undefined)?.wait) {
              return new Promise<string>((done) => {
                release = done
              })
            }
            return '{"ok":true}'
          }
        }
      }
    })
    base = hooks.url.replace(/\/mcp$/, '')
  })

  afterAll(async () => {
    await hooks?.stop()
  })

  const hook = (
    body: unknown,
    init: { headers?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<Response> =>
    fetch(`${base}${PRE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: init.signal
    })

  it('answers a session token with the handler reply', async () => {
    calls = []
    const token = tokens.issue({ ...scope, sessionId: 'hook1' })
    const res = await hook({ t: token, e: 'pre', p: { tool_name: 'Bash' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"ok":true}')
    expect(calls[0].scope).toMatchObject({ kind: 'session', sessionId: 'hook1' })
    expect(calls[0].payload).toEqual({ tool_name: 'Bash' })
  })

  it('refuses bad tokens, optimize tokens, Origin and oversized bodies with empty bodies', async () => {
    calls = []
    const run = tokens.issue({ kind: 'optimize', runId: 'hookrun', accountId: scope.accountId })
    const cases: [Promise<Response>, number][] = [
      [hook({ t: 'nope', p: {} }), 401],
      [hook({ p: {} }), 401],
      [hook({ t: run, p: {} }), 401],
      // The body must start with a token before anything else is read.
      [hook('not json'), 401],
      [hook(`{"t":"${tokens.issue({ ...scope, sessionId: 'hookj' })}", oops`), 400],
      [hook({ t: tokens.issue({ ...scope, sessionId: 'hook2' }), p: 'x'.repeat(2000) }), 413],
      [
        hook(
          { t: tokens.issue({ ...scope, sessionId: 'hook3' }), p: {} },
          { headers: { Origin: 'https://evil.example' } }
        ),
        403
      ]
    ]
    for (const [pending, status] of cases) {
      const res = await pending
      expect(res.status).toBe(status)
      expect(await res.text()).toBe('')
    }
    expect(calls).toEqual([])
    expect((await fetch(`${base}${PRE}`)).status).toBe(405)
    tokens.revoke('hookrun')
  })

  it('rate limits hook calls per tab with an empty body', async () => {
    const token = tokens.issue({ ...scope, sessionId: 'hook4' })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await hook({ t: token, p: {} })).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  it('keeps a long-poll open and signals when the client goes away', async () => {
    calls = []
    release = null
    const token = tokens.issue({ ...scope, sessionId: 'hook5' })
    const controller = new AbortController()
    const pending = hook({ t: token, p: { wait: true } }, { signal: controller.signal }).catch(
      () => null
    )
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await new Promise((done) => setTimeout(done, 300))
    expect(calls[0].signal.aborted).toBe(false)
    controller.abort()
    await pending
    await vi.waitFor(() => expect(calls[0].signal.aborted).toBe(true))
    finish('')
  })

  it('bounds unauthorised sockets with header, request and idle timeouts', () => {
    const server = createServer()
    server.timeout = 0
    configureTimeouts(server)
    expect(server.timeout).toBe(IDLE_TIMEOUT_MS)
    expect(server.headersTimeout).toBe(10_000)
    expect(server.requestTimeout).toBe(30_000)
  })

  it('refuses a body whose leading token is unknown before reading the rest', async () => {
    calls = []
    const res = await hook(`{"t":"${'0'.repeat(64)}","p":${JSON.stringify('x'.repeat(900))}}`)
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('refuses hook requests beyond the open request cap with 503', async () => {
    calls = []
    release = null
    const holders = ['hook7', 'hook8'].map((id) => {
      const controller = new AbortController()
      const token = tokens.issue({ ...scope, sessionId: id })
      return {
        controller,
        pending: hook({ t: token, p: { wait: true } }, { signal: controller.signal }).catch(
          () => null
        )
      }
    })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    const extra = await hook({ t: tokens.issue({ ...scope, sessionId: 'hook9' }), p: {} })
    expect(extra.status).toBe(503)
    expect(await extra.text()).toBe('')
    for (const h of holders) h.controller.abort()
    await Promise.all(holders.map((h) => h.pending))
    await vi.waitFor(async () =>
      expect(
        (await hook({ t: tokens.issue({ ...scope, sessionId: 'hook10' }), p: {} })).status
      ).toBe(200)
    )
  })

  it('answers a long-poll once the handler resolves', async () => {
    calls = []
    release = null
    const token = tokens.issue({ ...scope, sessionId: 'hook6' })
    const pending = hook({ t: token, p: { wait: true } })
    await vi.waitFor(() => expect(release).not.toBeNull())
    finish('{"hookSpecificOutput":{}}')
    const res = await pending
    expect(await res.text()).toBe('{"hookSpecificOutput":{}}')
    expect(calls[0].signal.aborted).toBe(false)
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
