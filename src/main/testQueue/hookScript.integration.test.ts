import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isWindows } from '../../test/platform'
import { startMcpServer, type HookRoute, type RunningMcpServer } from '../mcp/server'
import { createSessionTokens, type SessionScope } from '../mcp/sessionTokens'
import { findGitBash } from '../usage/statuslineScript'
import { HOOK_PATH_PREFIX, hookBaseUrl, hookScript } from './hookScript'

// The script as Claude Code runs it: /bin/sh on macOS, Git Bash on Windows (windows-latest has it).
const shell = isWindows ? findGitBash(process.env) : '/bin/sh'
const scope: SessionScope = { kind: 'session', sessionId: 'tab', projectId: 'p', accountId: 'a' }

let server: RunningMcpServer
let script: string
let received: { event: string; payload: unknown }[]
const tokens = createSessionTokens()
let token: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudedeck-tq-script-'))
  script = join(dir, 'test-queue.sh')
  writeFileSync(script, hookScript(1))
  token = tokens.issue(scope)
  const route = (event: string): HookRoute => ({
    maxBodyBytes: 1024 * 1024,
    handle: (s, payload) => {
      received.push({ event, payload })
      return s.sessionId === 'tab' && event === 'pre' ? '{"decision":"none"}' : ''
    }
  })
  server = await startMcpServer({
    tools: {},
    tokens,
    preferredPort: 0,
    routes: {
      [`${HOOK_PATH_PREFIX}pre`]: route('pre'),
      [`${HOOK_PATH_PREFIX}post`]: route('post')
    }
  })
})

afterAll(async () => {
  await server?.stop()
})

/** Runs the script asynchronously: the server answering it lives in this process. */
function runHook(
  event: string,
  stdin: string,
  env: Record<string, string>
): Promise<{ stdout: string; status: number | null }> {
  received = []
  return new Promise((done, fail) => {
    const child = spawn(shell as string, [script, event], {
      env: { ...process.env, CLAUDEDECK_MCP_TOKEN: '', CLAUDEDECK_HOOK_URL: '', ...env },
      windowsHide: true
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', fail)
    child.on('close', (status) => done({ stdout, status }))
    child.stdin.end(stdin)
  })
}

describe.runIf(shell)('generated hook script', { timeout: 30_000 }, () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: `echo "$(whoami)" \`id\` 'q' \\ $HOME && npm test` },
    tool_use_id: 'toolu_1',
    note: 'üñíçødé'
  }

  it('posts token, event and the payload untouched and prints the answer', async () => {
    const { stdout, status } = await runHook('pre', JSON.stringify(payload), {
      CLAUDEDECK_MCP_TOKEN: token,
      CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
    })
    expect(status).toBe(0)
    expect(stdout).toBe('{"decision":"none"}')
    expect(received).toEqual([{ event: 'pre', payload }])
  })

  it('sends post events to the post route', async () => {
    const { stdout } = await runHook('post', JSON.stringify(payload), {
      CLAUDEDECK_MCP_TOKEN: token,
      CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
    })
    expect(stdout).toBe('')
    expect(received.map((r) => r.event)).toEqual(['post'])
  })

  it('does nothing without a well formed token or URL', async () => {
    const url = hookBaseUrl(server.url)
    const cases: Record<string, string>[] = [
      {},
      { CLAUDEDECK_MCP_TOKEN: token },
      { CLAUDEDECK_MCP_TOKEN: token.toUpperCase(), CLAUDEDECK_HOOK_URL: url },
      { CLAUDEDECK_MCP_TOKEN: `${token}0`, CLAUDEDECK_HOOK_URL: url },
      { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: url.replace('127.0.0.1', 'example.com') },
      { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: `${url}$(touch x)` },
      { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: 'http://127.0.0.1:/hooks/' }
    ]
    for (const env of cases) {
      const { stdout, status } = await runHook('pre', JSON.stringify(payload), env)
      expect({ env, stdout, status }).toEqual({ env, stdout: '', status: 0 })
    }
    expect(
      await runHook('other', '{}', { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: url })
    ).toEqual({ stdout: '', status: 0 })
    expect(received).toEqual([])
  })

  it('passes through when the server answers 401 or is gone', async () => {
    const other = createSessionTokens().issue(scope)
    const unauthorised = await runHook('pre', JSON.stringify(payload), {
      CLAUDEDECK_MCP_TOKEN: other,
      CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
    })
    expect(unauthorised.stdout).toBe('')
    const gone = await runHook('pre', JSON.stringify(payload), {
      CLAUDEDECK_MCP_TOKEN: token,
      CLAUDEDECK_HOOK_URL: 'http://127.0.0.1:9/hooks/test-queue/'
    })
    expect(gone.stdout).toBe('')
    expect(gone.status).not.toBe(2)
  })
})
