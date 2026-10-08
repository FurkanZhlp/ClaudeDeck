import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isWindows } from '../../test/platform'
import { createGuardLog } from '../guard/guardLog'
import { createGuardService } from '../guard/guardService'
import { startMcpServer, type HookRoute, type RunningMcpServer } from '../mcp/server'
import { createSessionTokens, type SessionScope } from '../mcp/sessionTokens'
import { defaultGuardSettings } from '../state/guardSettings'
import { findGitBash } from '../usage/statuslineScript'
import { hookRoutes } from './hookRoutes'
import { GUARD_UNAVAILABLE_REPLY, hookBaseUrl, hookScript, WAIT_MARKER } from './hookScript'

/*
 * The generated script against a real server, the real routes and the real guard. Only
 * harmless sentinel payloads are used (`echo GUARD-SENTINEL-...`), and the hook never runs the
 * command it is asked about anyway: it only posts the payload.
 */

// The script as Claude Code runs it: /bin/sh on macOS, Git Bash on Windows (windows-latest has it).
const shell = isWindows ? findGitBash(process.env) : '/bin/sh'
const scope: SessionScope = { kind: 'session', sessionId: 'tab', projectId: 'p', accountId: 'a' }
const tokens = createSessionTokens()
const log = createGuardLog()

let server: RunningMcpServer
let guardScript: string
let queueScript: string
let token: string
let queueOn = true
let received: { event: string; payload: unknown }[]
/** WAIT answers before the queue decision. */
let waits = 0
/** Queue polls are held until the client goes away (signal kept here). */
let hold: AbortSignal[] | null = null

const sentinel = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tool_name: 'Bash',
  tool_input: { command: `echo GUARD-SENTINEL-${id}` },
  tool_use_id: `toolu_${id}`,
  cwd: tmpdir(),
  ...extra
})

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudedeck-hook-script-'))
  guardScript = join(dir, 'hook.sh')
  queueScript = join(dir, 'queue-only.sh')
  writeFileSync(guardScript, hookScript({ guard: true, maxWaitMinutes: 1 }))
  writeFileSync(queueScript, hookScript({ guard: false, maxWaitMinutes: 1 }))
  token = tokens.issue(scope)
  const settings = {
    ...defaultGuardSettings(),
    customRules: [
      {
        id: 'deny-sentinel',
        kind: 'prefix' as const,
        pattern: 'echo GUARD-SENTINEL-DENY*',
        action: 'deny' as const
      },
      {
        id: 'ask-sentinel',
        kind: 'prefix' as const,
        pattern: 'echo GUARD-SENTINEL-ASK*',
        action: 'ask' as const
      }
    ]
  }
  const guard = createGuardService({
    settings: () => settings,
    project: () => ({ id: 'p', name: 'P', path: tmpdir(), accountId: 'a' }),
    account: () => undefined,
    appDataDir: join(dir, 'app-data'),
    home: join(dir, 'home'),
    os: process.platform,
    env: {},
    log
  })
  const routes = hookRoutes({
    guard: {
      check: (s, payload) => {
        const note = (payload as { note?: string }).note
        if (note === 'boom') throw new Error('guard step failed')
        return guard.check(s, payload)
      }
    },
    service: {
      pre: (_s, _payload, signal) => {
        if (hold) {
          hold.push(signal)
          return new Promise<string>(() => undefined)
        }
        if (waits > 0) {
          waits -= 1
          return Promise.resolve(WAIT_MARKER)
        }
        return Promise.resolve('{"queue":"done"}')
      },
      post: () => undefined
    },
    queueEnabled: () => queueOn,
    isLive: () => true
  })
  // Records every request, and holds a guard step marked `hang` past the script's 5 s budget.
  const recorded: Record<string, HookRoute> = {}
  for (const [path, route] of Object.entries(routes)) {
    recorded[path] = {
      maxBodyBytes: route.maxBodyBytes,
      handle: (s, payload, signal, event) => {
        received.push({ event, payload })
        if ((payload as { note?: string }).note === 'hang')
          return new Promise<string>(() => undefined)
        return route.handle(s, payload, signal, event)
      }
    }
  }
  server = await startMcpServer({ tools: {}, tokens, preferredPort: 0, routes: recorded })
})

afterAll(async () => {
  await server?.stop()
})

/** Runs the script asynchronously: the server answering it lives in this process. */
function runHook(
  event: string,
  stdin: string,
  env: Record<string, string>,
  opts: {
    script?: string
    onSpawn?: (child: ReturnType<typeof spawn>) => void
    args?: string[]
  } = {}
): Promise<{ stdout: string; status: number | null }> {
  received = []
  const script = opts.script ?? guardScript
  return new Promise((done, fail) => {
    const child = spawn(shell as string, opts.args ?? [script, event], {
      env: { ...process.env, CLAUDEDECK_MCP_TOKEN: '', CLAUDEDECK_HOOK_URL: '', ...env },
      windowsHide: true
    })
    opts.onSpawn?.(child)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', fail)
    child.on('close', (status) => done({ stdout, status }))
    child.stdin.end(stdin)
  })
}

const tab = (): Record<string, string> => ({
  CLAUDEDECK_MCP_TOKEN: token,
  CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
})

describe.runIf(shell)('generated hook script', { timeout: 30_000 }, () => {
  it('answers a guard deny at once, with a reason and a terminal message', async () => {
    const payload = sentinel('DENY-1')
    const { stdout, status } = await runHook('pre', JSON.stringify(payload), tab())
    expect(status).toBe(0)
    const reply = JSON.parse(stdout)
    expect(reply.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny'
    })
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain(
      'ClaudeDeck guard (Custom rule)'
    )
    expect(reply.systemMessage).toContain('echo GUARD-SENTINEL-DENY-1')
    expect(received).toEqual([{ event: 'guard', payload }])
    expect(log.list()[0]).toMatchObject({
      ruleId: 'deny-sentinel',
      action: 'deny',
      sessionId: 'tab'
    })
  })

  it('answers ask the same way', async () => {
    const { stdout } = await runHook('pre', JSON.stringify(sentinel('ASK-1')), tab())
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('ask')
  })

  it('posts the payload untouched (quotes, substitutions, unicode)', async () => {
    queueOn = false
    try {
      const payload = sentinel('ALLOW-1', {
        tool_input: { command: `echo GUARD-SENTINEL-ALLOW "$(whoami)" \`id\` 'q' \\ $HOME` },
        note: 'üñíçødé'
      })
      const { stdout, status } = await runHook('pre', JSON.stringify(payload), tab())
      expect({ stdout, status }).toEqual({ stdout: '', status: 0 })
      expect(received).toEqual([{ event: 'guard', payload }])
    } finally {
      queueOn = true
    }
  })

  it('goes on with the queue polls after the guard allows a shell call', async () => {
    waits = 2
    const payload = sentinel('QUEUE-1')
    const { stdout, status } = await runHook('pre', JSON.stringify(payload), tab())
    expect(status).toBe(0)
    expect(stdout).toBe('{"queue":"done"}')
    expect(received.map((r) => r.event)).toEqual(['guard', 'pre', 'pre', 'pre'])
  })

  it('sends post events to the post route only', async () => {
    const { stdout } = await runHook('post', JSON.stringify(sentinel('POST-1')), tab())
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
      const { stdout, status } = await runHook('pre', JSON.stringify(sentinel('DENY-2')), env)
      expect({ env, stdout, status }).toEqual({ env, stdout: '', status: 0 })
    }
    expect(await runHook('other', '{}', tab())).toEqual({ stdout: '', status: 0 })
    expect(received).toEqual([])
  })

  it('lets a call through when the server does not know the token (401)', async () => {
    const other = createSessionTokens().issue(scope)
    const { stdout, status } = await runHook('pre', JSON.stringify(sentinel('DENY-3')), {
      CLAUDEDECK_MCP_TOKEN: other,
      CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url)
    })
    expect({ stdout, status }).toEqual({ stdout: '', status: 0 })
  })

  it('fails closed when the server is gone, errors or does not answer in time', async () => {
    const gone = await runHook('pre', JSON.stringify(sentinel('ALLOW-2')), {
      CLAUDEDECK_MCP_TOKEN: token,
      CLAUDEDECK_HOOK_URL: 'http://127.0.0.1:9/hooks/'
    })
    expect(gone).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })

    const failed = await runHook(
      'pre',
      JSON.stringify(sentinel('ALLOW-3', { note: 'boom' })),
      tab()
    )
    expect(failed).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })

    const start = Date.now()
    const slow = await runHook('pre', JSON.stringify(sentinel('ALLOW-4', { note: 'hang' })), tab())
    expect(slow).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
    expect(Date.now() - start).toBeLessThan(15_000)
  })

  it('passes through on failures while only the queue is on', async () => {
    const gone = await runHook(
      'pre',
      JSON.stringify(sentinel('ALLOW-5')),
      { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: 'http://127.0.0.1:9/hooks/' },
      { script: queueScript }
    )
    expect(gone).toEqual({ stdout: '', status: 0 })
  })

  it('exits 0 with the unavailable reply when curl fails with exit code 2', async () => {
    // The script is sourced after defining a `curl` that fails with 2 (Git Bash puts its own
    // folders first on PATH, so a fake curl on PATH would not be used there).
    const failingCurl = 'curl() { cat >/dev/null; return 2; }; set -- pre; . "$0"'
    const { stdout, status } = await runHook('pre', JSON.stringify(sentinel('ALLOW-6')), tab(), {
      args: ['-c', failingCurl, guardScript]
    })
    expect({ stdout, status }).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
    expect(received).toEqual([])
  })

  // Windows cannot deliver SIGTERM to a Git Bash process (it is terminated outright).
  it.skipIf(isWindows)(
    'ends curl on SIGTERM so the server sees the close, and exits 0',
    async () => {
      hold = []
      try {
        let child: ReturnType<typeof spawn> | null = null
        const run = runHook('pre', JSON.stringify(sentinel('QUEUE-2')), tab(), {
          onSpawn: (c) => (child = c)
        })
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
})
