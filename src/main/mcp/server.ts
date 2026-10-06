import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_SERVER_NAME } from './register'
import type { McpScope, SessionTokens } from './sessionTokens'
import type { ToolName, ToolResult, Tools } from './tools'

export const DEFAULT_MCP_PORT = 47821
const HOST = '127.0.0.1'
const MCP_PATH = '/mcp'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const DEFAULT_RATE_LIMIT: RateLimit = { limit: 60, windowMs: 60_000 }

export interface RateLimit {
  limit: number
  windowMs: number
}

export interface McpServerOptions {
  tools: Tools
  tokens: SessionTokens
  preferredPort?: number
  version?: string
  /** Tool calls allowed per session and window; defaults to 60 per minute. */
  rateLimit?: RateLimit
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
  tools: Tools,
  version: string,
  scope: McpScope,
  allow: (key: string) => boolean
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version })
  for (const [name, tool] of Object.entries(tools) as [ToolName, Tools[ToolName]][]) {
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => (allow(scope.sessionId) ? tool.call(args, scope) : RATE_LIMITED)
    )
  }
  return server
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
  let allowedHosts: string[] = []

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return sendError(res, 403, 'Forbidden')
    // Claude Code never sends Origin; a browser always does, so refuse any web page outright.
    if (req.headers.origin !== undefined) return sendError(res, 403, 'Forbidden')
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== MCP_PATH) {
      return sendError(res, 404, 'Not found')
    }
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
      sendError(res, 500, 'Internal error')
    })
  })

  const preferred = opts.preferredPort ?? DEFAULT_MCP_PORT
  let port: number
  try {
    port = await listen(http, preferred)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw error
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
