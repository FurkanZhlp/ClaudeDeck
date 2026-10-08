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
/** Hook requests open at once (all tabs together); more are refused with 503. */
export const MAX_ROUTE_REQUESTS = 300
/** Idle socket timeout for anything not authorised yet. */
export const IDLE_TIMEOUT_MS = 60_000
export const HEADERS_TIMEOUT_MS = 10_000
/** Receiving a whole request (bodies are small and local). */
export const REQUEST_TIMEOUT_MS = 30_000
/** Hook bodies start with the token: `{"t":"<64 hex>"`, checked before the rest is read. */
const TOKEN_PREFIX = /^\{"t":"([0-9a-f]{64})"/
const TOKEN_PREFIX_BYTES = 71

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
/** A caller known only by its account's guard key (no tab). */
export interface AccountScope {
  kind: 'account'
  accountId: string
}

export type RouteScope = SessionScope | AccountScope

export interface HookRoute {
  maxBodyBytes: number
  /**
   * Checks the body's `t` itself instead of a tab token (the account guard key); null refuses
   * with 401. Without it only tab (session) tokens are accepted.
   */
  authenticate?: (token: string) => AccountScope | null
  /**
   * Resolves with the response body ('' = no decision). `signal` aborts when the client leaves;
   * `event` is the body's `e` ('' when missing).
   */
  handle(
    scope: RouteScope,
    payload: unknown,
    signal: AbortSignal,
    event: string
  ): Promise<string> | string
}

export interface McpServerOptions {
  tools: ToolSet
  tokens: SessionTokens
  preferredPort?: number
  version?: string
  /** Tool calls allowed per session or run and window; defaults to 60 per minute. */
  rateLimit?: RateLimit
  /** Hook routes by exact path (e.g. `/hooks/pre`). */
  routes?: Record<string, HookRoute>
  /** Hook calls allowed per session and window; defaults to 600 per minute. */
  routeRateLimit?: RateLimit
  /** Hook requests open at once; defaults to MAX_ROUTE_REQUESTS. */
  maxRouteRequests?: number
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

/**
 * Reads the request body up to `max` bytes; more is drained and refused with 413. `accept`
 * sees the first `prefixBytes` (or the whole body when shorter) once; false refuses with 401
 * without keeping the rest.
 */
function readBody(
  req: IncomingMessage,
  max: number,
  accept: (prefix: string) => boolean = () => true,
  prefixBytes = 0
): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    req.resume()
    return Promise.resolve({ ok: false, status: 413 })
  }
  return new Promise((done) => {
    const chunks: Buffer[] = []
    let size = 0
    let refused: number | null = null
    let checked = false
    const check = (): void => {
      checked = true
      if (!accept(Buffer.concat(chunks).subarray(0, prefixBytes).toString('utf8'))) {
        refused = 401
        chunks.length = 0
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (refused !== null) return
      size += chunk.length
      if (size > max) {
        refused = 413
        chunks.length = 0
        return
      }
      chunks.push(chunk)
      if (!checked && size >= prefixBytes) check()
    })
    req.on('end', () => {
      if (refused === null && !checked) check()
      done(
        refused !== null
          ? { ok: false, status: refused }
          : { ok: true, text: Buffer.concat(chunks).toString('utf8') }
      )
    })
    req.on('error', () => done({ ok: false, status: 400 }))
  })
}

/** The caller a route accepts for a token: a tab, or an account for `authenticate` routes. */
function routeCaller(route: HookRoute, tokens: SessionTokens, token: string): RouteScope | null {
  if (route.authenticate) return route.authenticate(token)
  const scope = tokens.lookup(token)
  return scope?.kind === 'session' ? scope : null
}

/** A known token at the start of a hook body (cheap check before reading the rest). */
function tokenAhead(prefix: string, route: HookRoute, tokens: SessionTokens): boolean {
  const match = TOKEN_PREFIX.exec(prefix)
  return !!match && routeCaller(route, tokens, match[1]) !== null
}

async function handleRoute(
  route: HookRoute,
  req: IncomingMessage,
  res: ServerResponse,
  tokens: SessionTokens,
  allow: (key: string) => boolean
): Promise<void> {
  if (req.method !== 'POST') return sendEmpty(res, 405)
  const body = await readBody(
    req,
    route.maxBodyBytes,
    (prefix) => tokenAhead(prefix, route, tokens),
    TOKEN_PREFIX_BYTES
  )
  if (!body.ok) return sendEmpty(res, body.status)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return sendEmpty(res, 400)
  }
  const { t, e, p } = (parsed ?? {}) as { t?: unknown; e?: unknown; p?: unknown }
  // Optimize runs never reach hook routes.
  const scope = typeof t === 'string' ? routeCaller(route, tokens, t) : null
  if (!scope) return sendEmpty(res, 401)
  if (!allow(scope.kind === 'account' ? `account:${scope.accountId}` : scopeId(scope)))
    return sendEmpty(res, 429)
  // An authorised poll is held up to 20 s by the queue; no idle timeout applies to it.
  req.setTimeout(0)

  const aborted = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) aborted.abort()
  })
  const reply = await route.handle(scope, p, aborted.signal, typeof e === 'string' ? e : '')
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
 * Unauthenticated clients cannot hold sockets: headers within 10 s, the whole request within
 * 30 s, 60 s idle. Authorised requests (hook polls, MCP calls that wait for a confirmation
 * dialog) turn the idle timeout off for their socket.
 */
export function configureTimeouts(server: Server): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.timeout = IDLE_TIMEOUT_MS
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
  let openRouteRequests = 0
  const maxRouteRequests = opts.maxRouteRequests ?? MAX_ROUTE_REQUESTS

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
      if (openRouteRequests >= maxRouteRequests) {
        req.resume()
        return sendEmpty(res, 503)
      }
      openRouteRequests++
      res.once('close', () => openRouteRequests--)
      return handleRoute(route, req, res, opts.tokens, allowRoute)
    }
    if (path !== MCP_PATH) return sendError(res, 404, 'Not found')
    if (req.method === 'OPTIONS') return sendError(res, 405, 'Method not allowed')
    const scope = scopeOf(req, opts.tokens)
    if (!scope) return sendError(res, 401, 'Unauthorized')
    // Tool calls may wait minutes for the user's confirmation.
    req.setTimeout(0)
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
  configureTimeouts(http)

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
