import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isWindows } from '../../test/platform'
import { startMcpServer, type HookRoute, type RunningMcpServer } from '../mcp/server'
import { createSessionTokens, type SessionScope } from '../mcp/sessionTokens'
import { findGitBash } from '../usage/statuslineScript'
import { HOOK_PATH_PREFIX, hookBaseUrl, hookScript, WAIT_MARKER } from './hookScript'

// The script as Claude Code runs it: /bin/sh on macOS, Git Bash on Windows (windows-latest has it).
const shell = isWindows ? findGitBash(process.env) : '/bin/sh'
const scope: SessionScope = { kind: 'session', sessionId: 'tab', projectId: 'p', accountId: 'a' }

let server: RunningMcpServer
let script: string
let received: { event: string; payload: unknown }[]
/** WAIT answers before the decision, per pre poll. */
let waits = 0
/** Pre polls are held until the client goes away (signal kept here). */
let hold: AbortSignal[] | null = null
const tokens = createSessionTokens()
let token: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudedeck-tq-script-'))
  script = join(dir, 'test-queue.sh')
  writeFileSync(script, hookScript(1))
  token = tokens.issue(scope)
  const route = (event: string): HookRoute => ({
    maxBodyBytes: 1024 * 1024,
    handle: (s, payload, signal) => {
      received.push({ event, payload })
      if (event === 'pre' && hold) {
        hold.push(signal)
        return new Promise<string>(() => undefined)
      }
      if (event === 'pre' && waits > 0) {
        waits -= 1
        return WAIT_MARKER
      }
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
  env: Record<string, string>,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
  args: string[] = [script, event]
): Promise<{ stdout: string; status: number | null }> {
  received = []
  return new Promise((done, fail) => {
    const child = spawn(shell as string, args, {
      env: { ...process.env, CLAUDEDECK_MCP_TOKEN: '', CLAUDEDECK_HOOK_URL: '', ...env },
      windowsHide: true
    })
    onSpawn?.(child)
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

  it('polls again after a WAIT answer and prints the final decision', async () => {
    waits = 2
    const { stdout, status } = await runHook('pre', JSON.stringify(payload), {
      CLAUDEDECK_MCP_TOKEN: token,
      CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
    })
    expect(status).toBe(0)
    expect(stdout).toBe('{"decision":"none"}')
    expect(received).toEqual([
      { event: 'pre', payload },
      { event: 'pre', payload },
      { event: 'pre', payload }
    ])
  })

  it('exits 0 even when curl fails with exit code 2', async () => {
    // The script is sourced after defining a `curl` that fails with 2 (Git Bash puts its own
    // folders first on PATH, so a fake curl on PATH would not be used there).
    const failingCurl = 'curl() { cat >/dev/null; return 2; }; set -- pre; . "$0"'
    const { stdout, status } = await runHook(
      'pre',
      JSON.stringify(payload),
      { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url) },
      undefined,
      ['-c', failingCurl, script]
    )
    expect({ stdout, status }).toEqual({ stdout: '', status: 0 })
    expect(received).toEqual([])
  })

  // Windows cannot deliver SIGTERM to a Git Bash process (it is terminated outright).
  it.skipIf(isWindows)(
    'ends curl on SIGTERM so the server sees the close, and exits 0',
    async () => {
      hold = []
      try {
        let child: ReturnType<typeof spawn> | null = null
        const run = runHook(
          'pre',
          JSON.stringify(payload),
          { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url) },
          (c) => (child = c)
        )
        await vi.waitFor(() => expect(hold).toHaveLength(1), { timeout: 5000 })
        ;(child as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
        const { stdout, status } = await run
        expect({ stdout, status }).toEqual({ stdout: '', status: 0 })
        await vi.waitFor(() => expect(hold?.[0].aborted).toBe(true), { timeout: 5000 })
      } finally {
        hold = null
      }
    }
  )

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
