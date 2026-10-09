import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
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
import { createGuardKeys } from './guardKeys'
import {
  GUARD_KEY_FILE,
  guardKeyFile,
  GUARD_UNAVAILABLE_REPLY,
  hookBaseUrl,
  hookScript,
  WAIT_MARKER
} from './hookScript'
import { processStartTime } from './processIdentity'

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

const keys = createGuardKeys()
let server: RunningMcpServer
/** The guard script with the account's key file (key, server URL) next to it. */
let guardScript: string
let guardDir: string
/** The same script, used for the key (no tab env) cases. */
let keyScript: string
let keyDir: string
let queueScript: string
/** A server answering every hook call with 200 and an empty body (allow everything). */
let rogue: Server
let rogueUrl: string
/** A process id that is surely not running any more (a finished child's). */
let deadPid: number
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

let scripts = 0
/** A script in a folder of its own, with a key file (an account of its own) when `key` is given. */
function scriptIn(
  guard: boolean,
  key?: { url: string; pid?: number | null; start?: string | null }
): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudedeck-hook-'))
  const script = join(dir, 'hook.sh')
  writeFileSync(script, hookScript({ guard, maxWaitMinutes: 1, os: process.platform }))
  if (key) {
    writeFileSync(
      join(dir, GUARD_KEY_FILE),
      guardKeyFile({
        key: keys.rotate(`script-${++scripts}`),
        url: key.url,
        pid: key.pid,
        startTime: key.start
      }),
      { mode: 0o600 }
    )
  }
  return script
}

/** This test process as the key file names it: alive, with its real start time. */
const self = (): { pid: number; start: string | null } => ({
  pid: process.pid,
  start: processStartTime(process.pid, process.platform)
})

beforeAll(async () => {
  guardDir = mkdtempSync(join(tmpdir(), 'claudedeck-hook-script-'))
  guardScript = join(guardDir, 'hook.sh')
  queueScript = join(guardDir, 'queue-only.sh')
  writeFileSync(guardScript, hookScript({ guard: true, maxWaitMinutes: 1, os: process.platform }))
  writeFileSync(queueScript, hookScript({ guard: false, maxWaitMinutes: 1, os: process.platform }))
  token = tokens.issue(scope)
  // A harmless child that exits at once: its pid is free afterwards.
  deadPid = await new Promise<number>((done, fail) => {
    const child = spawn(shell as string, ['-c', 'echo GUARD-SENTINEL-PID'], { windowsHide: true })
    child.on('error', fail)
    child.on('close', () => done(child.pid as number))
  })
  rogue = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Length': '0' })
      res.end()
    })
  })
  await new Promise<void>((done) => rogue.listen(0, '127.0.0.1', done))
  const address = rogue.address()
  rogueUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hooks/`
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
    appDataDir: join(guardDir, 'app-data'),
    home: join(guardDir, 'home'),
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
    isLive: () => true,
    accountForKey: (key) => keys.lookup(key)
  })
  // Records every request, and holds a guard step marked `hang` past the script's 5 s budget.
  const recorded: Record<string, HookRoute> = {}
  for (const [path, route] of Object.entries(routes)) {
    recorded[path] = {
      ...route,
      handle: (s, payload, signal, event) => {
        received.push({ event, payload })
        if ((payload as { note?: string }).note === 'hang')
          return new Promise<string>(() => undefined)
        return route.handle(s, payload, signal, event)
      }
    }
  }
  server = await startMcpServer({ tools: {}, tokens, preferredPort: 0, routes: recorded })
  writeFileSync(
    join(guardDir, GUARD_KEY_FILE),
    guardKeyFile({ key: keys.rotate('g'), url: hookBaseUrl(server.url) }),
    { mode: 0o600 }
  )
  keyDir = mkdtempSync(join(tmpdir(), 'claudedeck-hook-key-'))
  keyScript = join(keyDir, 'hook.sh')
  writeFileSync(keyScript, hookScript({ guard: true, maxWaitMinutes: 1, os: process.platform }))
  writeKey(hookBaseUrl(server.url))
})

/** The account's key file next to `keyScript`, pointing at `url`. */
function writeKey(url: string, owner: { pid: number; start: string | null } | null = null): void {
  writeFileSync(
    join(keyDir, GUARD_KEY_FILE),
    guardKeyFile({ key: keys.rotate('a'), url, pid: owner?.pid, startTime: owner?.start }),
    { mode: 0o600 }
  )
}

afterAll(async () => {
  await server?.stop()
  await new Promise((done) => rogue?.close(done))
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

  it('does nothing without a token or a key file', async () => {
    const bare = scriptIn(true)
    const url = hookBaseUrl(server.url)
    const cases: Record<string, string>[] = [
      {},
      { CLAUDEDECK_HOOK_URL: url },
      { CLAUDEDECK_MCP_TOKEN: token.toUpperCase(), CLAUDEDECK_HOOK_URL: url },
      { CLAUDEDECK_MCP_TOKEN: `${token}0`, CLAUDEDECK_HOOK_URL: url }
    ]
    for (const env of cases) {
      const { stdout, status } = await runHook('pre', JSON.stringify(sentinel('DENY-2')), env, {
        script: bare
      })
      expect({ env, stdout, status }).toEqual({ env, stdout: '', status: 0 })
    }
    expect(await runHook('other', '{}', tab())).toEqual({ stdout: '', status: 0 })
    expect(received).toEqual([])
  })

  it('denies a tab call while the guard is on when the key file is missing or unusable', async () => {
    const bare = scriptIn(true)
    const badUrls = [
      'http://example.com:1/hooks/',
      `${hookBaseUrl(server.url)}$(touch x)`,
      'http://127.0.0.1:/hooks/'
    ]
    const scripts = [bare, ...badUrls.map((url) => scriptIn(true, { url }))]
    for (const script of scripts) {
      const reply = await runHook('pre', JSON.stringify(sentinel('ALLOW-8')), tab(), { script })
      expect(reply).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
    }
    expect(received).toEqual([])
    // Only the queue on: nothing to protect, the call goes ahead.
    const queue = await runHook('pre', JSON.stringify(sentinel('ALLOW-9')), tab(), {
      script: scriptIn(false)
    })
    expect(queue).toEqual({ stdout: '', status: 0 })
  })

  it('ignores a hook URL in the environment (a server that allows everything)', async () => {
    const env = { CLAUDEDECK_MCP_TOKEN: token, CLAUDEDECK_HOOK_URL: rogueUrl }
    const { stdout } = await runHook('pre', JSON.stringify(sentinel('DENY-R1')), env)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(received.map((r) => r.event)).toEqual(['guard'])
    // Without a key file the environment URL is not used either: the tab call is denied.
    const bare = await runHook('pre', JSON.stringify(sentinel('ALLOW-R2')), env, {
      script: scriptIn(true)
    })
    expect(bare).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
  })

  it('checks with the account key when the server does not know the token (401)', async () => {
    const other = createSessionTokens().issue(scope)
    const env = { CLAUDEDECK_MCP_TOKEN: other, CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url) }
    const denied = await runHook('pre', JSON.stringify(sentinel('DENY-3')), env)
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    // The tab route refuses the unknown token before any handler (401); the key route decides.
    expect(received.map((r) => r.event)).toEqual(['guard'])
    const allowed = await runHook('pre', JSON.stringify(sentinel('ALLOW-10')), env)
    expect(allowed).toEqual({ stdout: '', status: 0 })
    // A key file without a key (the URL only): the unknown token is denied.
    const urlOnly = scriptIn(true)
    writeFileSync(
      join(urlOnly, '..', GUARD_KEY_FILE),
      guardKeyFile({ key: '', url: hookBaseUrl(server.url) })
    )
    const noKey = await runHook('pre', JSON.stringify(sentinel('ALLOW-11')), env, {
      script: urlOnly
    })
    expect(noKey).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
  })

  it('fails closed when the server is gone, errors or does not answer in time', async () => {
    const gone = await runHook('pre', JSON.stringify(sentinel('ALLOW-2')), tab(), {
      script: scriptIn(true, { url: 'http://127.0.0.1:9/hooks/' })
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
    const gone = await runHook('pre', JSON.stringify(sentinel('ALLOW-5')), tab(), {
      script: scriptIn(false, { url: 'http://127.0.0.1:9/hooks/' })
    })
    expect(gone).toEqual({ stdout: '', status: 0 })
    // The queue script next to the guard's key file reaches the server through it.
    const queued = await runHook('pre', JSON.stringify(sentinel('QUEUE-3')), tab(), {
      script: queueScript
    })
    expect(queued.stdout).toBe('{"queue":"done"}')
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

  // Windows cannot deliver SIGTERM to a Git Bash process (it is terminated outright).
  it.skipIf(isWindows)('denies when it is killed during the guard step', async () => {
    let child: ReturnType<typeof spawn> | null = null
    const run = runHook('pre', JSON.stringify(sentinel('ALLOW-7', { note: 'hang' })), tab(), {
      onSpawn: (c) => (child = c)
    })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 })
    ;(child as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
    expect(await run).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
  })

  describe('without the tab env (guard key next to the script)', () => {
    it('checks the call with the account key, guard only', async () => {
      const denied = await runHook(
        'pre',
        JSON.stringify(sentinel('DENY-K1')),
        {},
        { script: keyScript }
      )
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      expect(received.map((r) => r.event)).toEqual(['guard'])
      expect(log.list()[0]).toMatchObject({
        ruleId: 'deny-sentinel',
        sessionId: '',
        accountId: 'a'
      })
      // Allowed calls get no answer and no queue polls, even with the queue on.
      const allowed = await runHook(
        'pre',
        JSON.stringify(sentinel('QUEUE-K1')),
        {},
        { script: keyScript }
      )
      expect(allowed).toEqual({ stdout: '', status: 0 })
      expect(received.map((r) => r.event)).toEqual(['guard'])
      expect(
        await runHook('post', JSON.stringify(sentinel('POST-K1')), {}, { script: keyScript })
      ).toEqual({ stdout: '', status: 0 })
    })

    it('uses the env token first and the key when the server does not know the token', async () => {
      const viaTab = await runHook('pre', JSON.stringify(sentinel('QUEUE-K2')), tab(), {
        script: keyScript
      })
      expect(viaTab.stdout).toBe('{"queue":"done"}')
      const other = createSessionTokens().issue(scope)
      const viaKey = await runHook(
        'pre',
        JSON.stringify(sentinel('DENY-K2')),
        { CLAUDEDECK_MCP_TOKEN: other, CLAUDEDECK_HOOK_URL: hookBaseUrl(server.url) },
        { script: keyScript }
      )
      expect(JSON.parse(viaKey.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    })

    it('passes only when ClaudeDeck is not running and denies on any other failure', async () => {
      try {
        // Nothing listens and the key file names no process (older file): not running.
        writeKey('http://127.0.0.1:9/hooks/')
        const gone = await runHook(
          'pre',
          JSON.stringify(sentinel('DENY-K3')),
          {},
          { script: keyScript }
        )
        expect(gone).toEqual({ stdout: '', status: 0 })
        // The process named in the key file is gone: not running.
        writeKey('http://127.0.0.1:9/hooks/', { pid: deadPid, start: 'Thu Jan 1 00:00:00 1970' })
        const dead = await runHook(
          'pre',
          JSON.stringify(sentinel('DENY-K6')),
          {},
          { script: keyScript }
        )
        expect(dead).toEqual({ stdout: '', status: 0 })
        if (!isWindows) {
          // The pid lives but started at another time (reused): not ClaudeDeck, not running.
          writeKey('http://127.0.0.1:9/hooks/', {
            pid: process.pid,
            start: 'Thu Jan 1 00:00:00 1970'
          })
          const reused = await runHook(
            'pre',
            JSON.stringify(sentinel('DENY-K7')),
            {},
            { script: keyScript }
          )
          expect(reused).toEqual({ stdout: '', status: 0 })
          // ClaudeDeck (this process) still runs but its server cannot be reached: denied.
          writeKey('http://127.0.0.1:9/hooks/', self())
          const blocked = await runHook(
            'pre',
            JSON.stringify(sentinel('ALLOW-K8')),
            {},
            { script: keyScript }
          )
          expect(blocked).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
        }
        writeKey(hookBaseUrl(server.url))
        const failed = await runHook(
          'pre',
          JSON.stringify(sentinel('ALLOW-K3', { note: 'boom' })),
          {},
          { script: keyScript }
        )
        expect(failed).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
        // Connected but no answer in time: denied.
        const slow = await runHook(
          'pre',
          JSON.stringify(sentinel('ALLOW-K5', { note: 'hang' })),
          {},
          { script: keyScript }
        )
        expect(slow).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
        // A key the server does not know (rotated twice since) is a failure too.
        writeFileSync(
          join(keyDir, GUARD_KEY_FILE),
          `${'0'.repeat(64)}\n${hookBaseUrl(server.url)}\n`
        )
        const unknown = await runHook(
          'pre',
          JSON.stringify(sentinel('ALLOW-K4')),
          {},
          { script: keyScript }
        )
        expect(unknown).toEqual({ stdout: `${GUARD_UNAVAILABLE_REPLY}\n`, status: 0 })
      } finally {
        writeKey(hookBaseUrl(server.url))
      }
    })
  })
})
