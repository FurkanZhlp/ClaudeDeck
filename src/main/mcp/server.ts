import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_SERVER_NAME } from './register'
import type { ToolName, Tools } from './tools'

export const DEFAULT_MCP_PORT = 47821
const HOST = '127.0.0.1'
const MCP_PATH = '/mcp'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export interface McpServerOptions {
  tools: Tools
  tokenFile: string
  preferredPort?: number
  version?: string
}

export interface RunningMcpServer {
  url: string
  token: string
  stop(): Promise<void>
}

/** Reads the persisted token, or creates one (0600, atomic) on first run. */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    try {
      const { token } = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (typeof token === 'string' && TOKEN_PATTERN.test(token)) return token
    } catch {
      // Unreadable token file: replace it below.
    }
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return token
}

// Hashing first gives equal lengths, so timingSafeEqual never throws or leaks the length.
const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  return !!match && timingSafeEqual(digest(match[1]), expected)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
  if (status === 405) headers.Allow = 'POST'
  res.writeHead(status, headers)
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function buildMcpServer(tools: Tools, version: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version })
  for (const [name, tool] of Object.entries(tools) as [ToolName, Tools[ToolName]][]) {
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.call(args)
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

/** Streamable HTTP MCP server on loopback, guarded by a bearer token. Stateless per request. */
export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const token = loadOrCreateToken(opts.tokenFile)
  const expected = digest(token)
  const version = opts.version ?? '0.0.0'
  let allowedHosts: string[] = []

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return sendError(res, 403, 'Forbidden')
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== MCP_PATH) {
      return sendError(res, 404, 'Not found')
    }
    if (!authorized(req, expected)) return sendError(res, 401, 'Unauthorized')
    // Stateless mode has no standalone SSE stream or session to delete.
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed')

    const server = buildMcpServer(opts.tools, version)
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
    token,
    stop: () =>
      new Promise<void>((done) => {
        http.close(() => done())
        http.closeAllConnections()
      })
  }
}
