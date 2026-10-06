import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Account, AccountUsage } from '../../shared/types'
import {
  createUsagePoller,
  FAILURE_BACKOFF_MS,
  usageWorkspace,
  type UsagePoller,
  type UsagePollerDeps
} from './usagePoller'

const OUTPUT =
  'Current session: 12% used · resets Oct 7 at 7:30am (Europe/Istanbul)\n' +
  'Current week (all models): 62% used · resets Oct 9 at 4am (Europe/Istanbul)'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  kill = vi.fn()

  succeed(text = OUTPUT): void {
    this.stdout.emit('data', `${JSON.stringify({ type: 'result', result: text })}\n`)
    this.emit('close', 0)
  }

  fail(): void {
    this.stderr.emit('data', 'Not logged in')
    this.emit('close', 1)
  }
}

const base = mkdtempSync(join(tmpdir(), 'claudedeck-usage-poll-'))
const account = (id: string): Account => ({
  id,
  name: id,
  color: '#000',
  configDir: join(base, id)
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

let poller: UsagePoller | null = null
let clock = 0
let accounts: Account[] = []
let children: FakeChild[] = []
let spawn: Mock<(file: string, args: string[], opts: SpawnOptions) => ChildProcess>
let onUsage: Mock<(usage: AccountUsage) => void>
let killTree: Mock<(child: ChildProcess, signal: NodeJS.Signals) => void>

const make = (overrides: Partial<UsagePollerDeps> = {}): UsagePoller => {
  poller = createUsagePoller({
    repo: { get: () => ({ accounts }) },
    baseEnv: async () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin' }),
    claudeAvailable: async () => true,
    onUsage,
    spawn,
    killTree,
    jitterMs: 0,
    intervalMs: 60 * 60_000,
    now: () => clock,
    ...overrides
  })
  return poller
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 7, 3)
  accounts = [account('a'), account('b')]
  children = []
  spawn = vi.fn(() => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  })
  onUsage = vi.fn()
  killTree = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  poller?.stop()
  poller = null
  vi.restoreAllMocks()
})

describe('createUsagePoller', () => {
  it('polls accounts one at a time through the login shell', async () => {
    make().start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    const [file, args, opts] = spawn.mock.calls[0] as [string, string[], SpawnOptions]
    expect(file).toBe('/bin/zsh')
    expect(args[0]).toBe('-ilc')
    expect(args[1]).toContain(`CLAUDE_CONFIG_DIR='${accounts[0].configDir}'`)
    expect(args[1]).toContain(
      "claude '-p' '/usage' '--strict-mcp-config' '--no-session-persistence'"
    )
    expect(opts).toMatchObject({
      cwd: usageWorkspace(accounts[0].configDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    expect((opts.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(accounts[0].configDir)

    await tick()
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].succeed()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(onUsage).toHaveBeenCalledWith({
      accountId: 'a',
      fiveHour: { usedPercentage: 12, resetsAt: Date.UTC(2026, 9, 7, 4, 30) },
      sevenDay: { usedPercentage: 62, resetsAt: Date.UTC(2026, 9, 9, 1) },
      models: [],
      updatedAt: clock
    })
    expect((spawn.mock.calls[1][2] as SpawnOptions).cwd).toBe(usageWorkspace(accounts[1].configDir))
    children[1].succeed()
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(2))
  })

  it('throttles pollSoon and skips fresh readings unless forced', async () => {
    accounts = [account('a')]
    const p = make()
    p.start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    children[0].succeed()
    await tick()

    clock += 10_000
    p.pollSoon()
    await tick()
    expect(spawn).toHaveBeenCalledTimes(1)

    // Throttled: the previous pollSoon was under a minute ago.
    clock += 55_000
    p.pollSoon()
    await tick()
    expect(spawn).toHaveBeenCalledTimes(1)

    clock += 10_000
    p.pollSoon()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    children[1].succeed()
    await tick()

    p.pollNow('a')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))
    children[2].succeed()
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(3))
  })

  it('backs off an account after repeated failures', async () => {
    accounts = [account('a')]
    const p = make()
    p.start()
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        clock += 61_000
        p.pollSoon()
      }
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(i + 1))
      children[i].fail()
      await tick()
    }
    expect(onUsage).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[usage] poll failed',
      'a',
      3,
      expect.stringContaining('Not logged in')
    )

    clock += 61_000
    p.pollSoon()
    await tick()
    expect(spawn).toHaveBeenCalledTimes(3)

    clock += FAILURE_BACKOFF_MS
    p.pollSoon()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4))
    children[3].succeed()
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1))
  })

  it('treats output without plan usage as a failure', async () => {
    accounts = [account('a')]
    make().start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    children[0].succeed('You are using API usage billing.')
    await tick()
    expect(onUsage).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[usage] poll failed', 'a', 1, 'no plan usage')
  })

  it('ignores accounts removed from the repository', async () => {
    const [a, b] = accounts
    make().start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    accounts = []
    children[0].succeed()
    await tick()
    expect(onUsage).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)

    accounts = [a, b]
    poller?.pollNow('missing')
    await tick()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('kills a poll that runs too long and moves on', async () => {
    make({ timeoutMs: 30 }).start()
    await vi.waitFor(() => expect(killTree).toHaveBeenCalledWith(children[0], 'SIGTERM'))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(console.warn).toHaveBeenCalledWith('[usage] poll failed', 'a', 1, 'timed out')
    // A late exit changes nothing.
    children[0].succeed()
    await tick()
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('skips everything when claude is unavailable or the account is signed out', async () => {
    make({ claudeAvailable: async () => false }).start()
    await tick()
    expect(spawn).not.toHaveBeenCalled()
    poller?.stop()

    make({ isSignedIn: (id) => id === 'b' }).start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(String(spawn.mock.calls[0][1][1])).toContain(accounts[1].configDir)
  })

  it('never throws when the environment cannot be resolved', async () => {
    make({ baseEnv: async () => Promise.reject(new Error('no shell')) }).start()
    await tick()
    expect(spawn).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[usage] poll failed', 'a', 1, 'no shell')
  })

  it('kills the running poll on stop', async () => {
    const p = make()
    p.start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    p.stop()
    expect(killTree).toHaveBeenCalledWith(children[0], 'SIGTERM')
    children[0].succeed()
    await tick()
    expect(onUsage).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
