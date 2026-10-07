import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_SERVER_NAME } from './register'
import { scopeId, type McpScope, type SessionScope, type SessionTokens } from './sessionTokens'
import type { Tool, ToolResult } from './tools'

export const DEFAULT_MCP_PORT = 47821
const HOST = '127.0.0.1'
const MCP_PATH = '/mcp'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const DEFAULT_RATE_LIMIT: RateLimit = { limit: 60, windowMs: 60_000 }
/** Hook calls are one per Bash tool call, so they get their own, larger budget. */
const DEFAULT_ROUTE_RATE_LIMIT: RateLimit = { limit: 600, windowMs: 60_000 }

export interface RateLimit {
  limit: number
  windowMs: number
}

/** Every tool the server exposes, by name; each tool enforces its own scope kind. */
export type ToolSet = Record<string, Tool>

/**
 * A non-MCP POST route for hooks. The body is `{"t": token, "e": event, "p": payload}`; the
 * server checks it and the token (session tokens only) before calling `handle`. Every refusal
 * answers with an empty body: a hook treats it as "no decision".
 */
export interface HookRoute {
  maxBodyBytes: number
  /** Resolves with the response body ('' = no decision). `signal` aborts when the client leaves. */
  handle(scope: SessionScope, payload: unknown, signal: AbortSignal): Promise<string> | string
}

export interface McpServerOptions {
  tools: ToolSet
  tokens: SessionTokens
  preferredPort?: number
  version?: string
  /** Tool calls allowed per session or run and window; defaults to 60 per minute. */
  rateLimit?: RateLimit
  /** Hook routes by exact path (e.g. `/hooks/test-queue/pre`). */
  routes?: Record<string, HookRoute>
  /** Hook calls allowed per session and window; defaults to 600 per minute. */
  routeRateLimit?: RateLimit
}

export interface RunningMcpServer {
  url: string
  stop(): Promise<void>
}

/** Fixed-window counter per key. */
function createLimiter({ limit, windowMs }: RateLimit): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>()
  return (key) => {
    const now = Date.now()
    if (windows.size > 1000) {
      for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k)
    }
    const current = windows.get(key)
    if (!current || now - current.start >= windowMs) {
      windows.set(key, { start: now, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= limit
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
  if (status === 405) headers.Allow = 'POST'
  res.writeHead(status, headers)
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/** Status only, empty body: a hook reads nothing and lets the tool call go ahead. */
function sendEmpty(res: ServerResponse, status: number): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': '0' })
  res.end()
}

type BodyResult = { ok: true; text: string } | { ok: false; status: number }

/** Reads the request body up to `max` bytes; more is drained and refused with 413. */
function readBody(req: IncomingMessage, max: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    req.resume()
    return Promise.resolve({ ok: false, status: 413 })
  }
  return new Promise((done) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > max) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () =>
      done(
        tooLarge
          ? { ok: false, status: 413 }
          : { ok: true, text: Buffer.concat(chunks).toString('utf8') }
      )
    )
    req.on('error', () => done({ ok: false, status: 400 }))
  })
}

async function handleRoute(
  route: HookRoute,
  req: IncomingMessage,
  res: ServerResponse,
  tokens: SessionTokens,
  allow: (key: string) => boolean
): Promise<void> {
  if (req.method !== 'POST') return sendEmpty(res, 405)
  const body = await readBody(req, route.maxBodyBytes)
  if (!body.ok) return sendEmpty(res, body.status)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return sendEmpty(res, 400)
  }
  const { t, p } = (parsed ?? {}) as { t?: unknown; p?: unknown }
  const scope = typeof t === 'string' ? tokens.lookup(t) : null
  // Optimize runs never reach hook routes.
  if (!scope || scope.kind !== 'session') return sendEmpty(res, 401)
  if (!allow(scopeId(scope))) return sendEmpty(res, 429)

  const aborted = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) aborted.abort()
  })
  const reply = await route.handle(scope, p, aborted.signal)
  if (res.destroyed || res.writableEnded) return
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(reply))
  })
  res.end(reply)
}

// The token lives in a Map keyed by its SHA-256 (see sessionTokens), so no comparison of secret
// bytes happens here and timingSafeEqual is not needed.
function scopeOf(req: IncomingMessage, tokens: SessionTokens): McpScope | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  return match ? tokens.lookup(match[1]) : null
}

const RATE_LIMITED: ToolResult = {
  content: [{ type: 'text', text: 'Rate limit exceeded, try again in a minute.' }],
  isError: true
}

function buildMcpServer(
  tools: ToolSet,
  version: string,
  scope: McpScope,
  allow: (key: string) => boolean
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version })
  for (const [name, tool] of Object.entries(tools)) {
    // A tab never sees the optimize tools and an optimize run never sees the project tools.
    if (tool.scopeKind !== scope.kind) continue
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => (allow(scopeId(scope)) ? tool.call(args, scope) : RATE_LIMITED)
    )
  }
  return server
}

/**
 * The preferred port is taken (EADDRINUSE) or excluded (EACCES: Windows reserves port ranges
 * for Hyper-V and WinNAT); either way a random free port works.
 */
export function canUseRandomPort(error: unknown, preferred: number): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return preferred !== 0 && (code === 'EADDRINUSE' || code === 'EACCES')
}

/**
 * Hook long-polls stay open up to the queue's max wait (hours): no idle socket timeout. The
 * request timeout only covers receiving the request, which hooks send at once.
 */
export function allowLongPolls(server: Server): void {
  server.timeout = 0
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      fail(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      done((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

/**
 * Streamable HTTP MCP server on loopback. Each Claude tab authenticates with its own short-lived
 * token, and every tool call runs within that tab's scope. Stateless per request.
 */
export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const version = opts.version ?? '0.0.0'
  const allow = createLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT)
  const allowRoute = createLimiter(opts.routeRateLimit ?? DEFAULT_ROUTE_RATE_LIMIT)
  const routes = new Map(Object.entries(opts.routes ?? {}))
  let allowedHosts: string[] = []

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.get(path)
    // Hook routes answer every refusal with an empty body ("no decision" for the hook).
    const forbidden = (): void => (route ? sendEmpty(res, 403) : sendError(res, 403, 'Forbidden'))
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return forbidden()
    // Claude Code never sends Origin; a browser always does, so refuse any web page outright.
    if (req.headers.origin !== undefined) return forbidden()
    if (route) {
      // Same DNS rebinding guard the MCP transport applies.
      if (!allowedHosts.includes(req.headers.host ?? '')) return sendEmpty(res, 403)
      return handleRoute(route, req, res, opts.tokens, allowRoute)
    }
    if (path !== MCP_PATH) return sendError(res, 404, 'Not found')
    if (req.method === 'OPTIONS') return sendError(res, 405, 'Method not allowed')
    const scope = scopeOf(req, opts.tokens)
    if (!scope) return sendError(res, 401, 'Unauthorized')
    // Stateless mode has no standalone SSE stream or session to delete.
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed')

    const server = buildMcpServer(opts.tools, version, scope, allow)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[mcp] request failed', error)
      if (routes.has(new URL(req.url ?? '/', 'http://localhost').pathname)) sendEmpty(res, 500)
      else sendError(res, 500, 'Internal error')
    })
  })
  allowLongPolls(http)

  const preferred = opts.preferredPort ?? DEFAULT_MCP_PORT
  let port: number
  try {
    port = await listen(http, preferred)
  } catch (error) {
    if (!canUseRandomPort(error, preferred)) throw error
    port = await listen(http, 0)
  }
  allowedHosts = [`${HOST}:${port}`, `localhost:${port}`]

  return {
    url: `http://${HOST}:${port}${MCP_PATH}`,
    stop: () =>
      new Promise<void>((done) => {
        http.close(() => done())
        http.closeAllConnections()
      })
  }
}
