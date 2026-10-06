import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MCP_SERVER_NAME = 'claudedeck'

/**
 * Points the account's user-scope `mcpServers.claudedeck` at the running server.
 * Keeps every other key; returns true when the file changed. Throws on unparsable JSON so a
 * broken file is never overwritten.
 */
export function registerMcpInConfig(configDir: string, url: string, token: string): boolean {
  const file = join(configDir, '.claude.json')
  const json = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {}
  const entry = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
  const current = json.mcpServers
  const servers =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}
  if (JSON.stringify(servers[MCP_SERVER_NAME]) === JSON.stringify(entry)) return false

  json.mcpServers = { ...servers, [MCP_SERVER_NAME]: entry }
  mkdirSync(configDir, { recursive: true })
  const tmp = `${file}.claudedeck-tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return true
}
