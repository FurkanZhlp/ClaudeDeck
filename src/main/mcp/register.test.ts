import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { registerMcpInConfig, unregisterMcpInConfig } from './register'

let dir: string
const read = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-mcp-reg-'))
})

describe('registerMcpInConfig', () => {
  it('creates the file with only the server entry when missing', () => {
    const configDir = join(dir, 'acc')
    dir = configDir
    expect(registerMcpInConfig(configDir, 'http://127.0.0.1:1/mcp')).toBe(true)
    expect(read()).toEqual({
      mcpServers: {
        claudedeck: {
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer ${CLAUDEDECK_MCP_TOKEN}' }
        }
      }
    })
    expect(readFileSync(join(configDir, '.claude.json'), 'utf8')).not.toMatch(/[0-9a-f]{64}/)
    expect(statSync(join(configDir, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  it('keeps other keys and servers, and is a no-op when already current', () => {
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { a: 1 }, mcpServers: { other: { command: 'x' } } })
    )
    expect(registerMcpInConfig(dir, 'http://127.0.0.1:1/mcp')).toBe(true)
    expect(registerMcpInConfig(dir, 'http://127.0.0.1:1/mcp')).toBe(false)
    const json = read()
    expect(json.oauthAccount).toEqual({ a: 1 })
    expect(Object.keys(json.mcpServers as object)).toEqual(['other', 'claudedeck'])

    expect(registerMcpInConfig(dir, 'http://127.0.0.1:2/mcp')).toBe(true)
    expect((read().mcpServers as Record<string, { url: string }>).claudedeck.url).toBe(
      'http://127.0.0.1:2/mcp'
    )
    expect(existsSync(join(dir, '.claude.json.claudedeck-tmp'))).toBe(false)
  })

  it('replaces an old entry that carried a literal token', () => {
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          claudedeck: { type: 'http', url: 'u', headers: { Authorization: 'Bearer abc' } }
        }
      })
    )
    expect(registerMcpInConfig(dir, 'u')).toBe(true)
    expect(JSON.stringify(read())).not.toContain('Bearer abc')
  })

  it('refuses to overwrite an unparsable file', () => {
    writeFileSync(join(dir, '.claude.json'), '{broken')
    expect(() => registerMcpInConfig(dir, 'u')).toThrow()
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe('{broken')
  })
})

describe('unregisterMcpInConfig', () => {
  it('removes only our entry', () => {
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { a: 1 }, mcpServers: { other: { command: 'x' } } })
    )
    registerMcpInConfig(dir, 'u')
    expect(unregisterMcpInConfig(dir)).toBe(true)
    expect(read()).toEqual({ oauthAccount: { a: 1 }, mcpServers: { other: { command: 'x' } } })
    expect(unregisterMcpInConfig(dir)).toBe(false)
    expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  it('is a no-op when the file is missing and throws on an unparsable one', () => {
    expect(unregisterMcpInConfig(join(dir, 'none'))).toBe(false)
    writeFileSync(join(dir, '.claude.json'), '{broken')
    expect(() => unregisterMcpInConfig(dir)).toThrow()
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe('{broken')
  })
})
