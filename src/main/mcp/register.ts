import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_TOKEN_ENV } from './sessionTokens'

export const MCP_SERVER_NAME = 'claudedeck'

// Literal placeholder: Claude Code expands it from the claude process env, so no token is stored.
export const AUTH_HEADER = `Bearer \${${MCP_TOKEN_ENV}}`

const serverEntry = (url: string): Record<string, unknown> => ({
  type: 'http',
  url,
  headers: { Authorization: AUTH_HEADER }
})

/** JSON for `claude --mcp-config` with only the ClaudeDeck server; carries no token. */
export function inlineMcpConfig(url: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: serverEntry(url) } })
}

type Json = Record<string, unknown>

function readConfig(file: string): Json {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Json) : {}
}

function serversOf(json: Json): Json {
  const current = json.mcpServers
  return current && typeof current === 'object' && !Array.isArray(current) ? (current as Json) : {}
}

function writeConfig(configDir: string, file: string, json: Json): void {
  mkdirSync(configDir, { recursive: true })
  const tmp = `${file}.claudedeck-tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Points the account's user-scope `mcpServers.claudedeck` at the running server.
 * Keeps every other key; returns true when the file changed. Throws on unparsable JSON so a
 * broken file is never overwritten.
 */
export function registerMcpInConfig(configDir: string, url: string): boolean {
  const file = join(configDir, '.claude.json')
  const json = readConfig(file)
  const entry = serverEntry(url)
  const servers = serversOf(json)
  if (JSON.stringify(servers[MCP_SERVER_NAME]) === JSON.stringify(entry)) return false

  json.mcpServers = { ...servers, [MCP_SERVER_NAME]: entry }
  writeConfig(configDir, file, json)
  return true
}

/** Removes our entry, keeping everything else. Returns true when the file changed. */
export function unregisterMcpInConfig(configDir: string): boolean {
  const file = join(configDir, '.claude.json')
  if (!existsSync(file)) return false
  const json = readConfig(file)
  const servers = serversOf(json)
  if (!(MCP_SERVER_NAME in servers)) return false

  const rest = { ...servers }
  delete rest[MCP_SERVER_NAME]
  json.mcpServers = rest
  writeConfig(configDir, file, json)
  return true
}
