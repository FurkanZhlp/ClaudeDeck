import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, GuardSettings, Project, TestQueueSettings } from '../../shared/types'
import { defaultGuardSettings } from '../state/guardSettings'
import { defaultTestQueueSettings } from '../state/testQueueSettings'
import { createGuardKeys } from './guardKeys'
import { guardKeyPath, hookScriptPath, type HookHost } from './hookInstaller'
import { nodeHookStatusFs, type HookStatusFs } from './hookStatus'
import type { WatchFs } from './hookWatch'
import { createClaudeDeckHooks, type ClaudeDeckHooks } from './claudeDeckHooks'

const mac: HookHost = { os: 'darwin', env: {} }
const emptyFs: HookStatusFs = { readJson: () => undefined, list: () => [], exists: () => false }

let accounts: Account[]
let projects: Project[]
let settings: TestQueueSettings
let guard: GuardSettings
let lastCalls: Record<string, number>
let hooks: ClaudeDeckHooks

const account = (id: string): Account => ({
  id,
  name: id,
  color: 'blue',
  configDir: mkdtempSync(join(tmpdir(), `cd-tqhooks-${id}-`))
})
const settingsOf = (a: Account): Record<string, unknown> =>
  JSON.parse(readFileSync(join(a.configDir, 'settings.json'), 'utf8')) as Record<string, unknown>

beforeEach(() => {
  accounts = [account('a1'), account('a2')]
  projects = []
  settings = { ...defaultTestQueueSettings(), enabled: true }
  guard = { ...defaultGuardSettings(), enabled: false }
  lastCalls = {}
  hooks = createClaudeDeckHooks({
    accounts: () => accounts,
    projects: () => projects,
    settings: () => ({ guard, testQueue: settings }),
    lastCallAt: (id) => lastCalls[id] ?? null,
    host: mac,
    fs: emptyFs
  })
})

describe('createClaudeDeckHooks', () => {
  it('installs every account while enabled and reports it', async () => {
    hooks.syncAll()
    for (const a of accounts) {
      expect(existsSync(hookScriptPath(a.configDir))).toBe(true)
      expect(settingsOf(a).hooks).toHaveProperty('PreToolUse')
    }
    lastCalls.a1 = 123
    const status = await hooks.status()
    expect(status.accounts).toEqual([
      { accountId: 'a1', installed: true, lastCallAt: 123, problem: null },
      { accountId: 'a2', installed: true, lastCallAt: null, problem: null }
    ])
    expect(status.managedHooksOnly).toBe(false)
    expect(status.hooksDisabledProjectIds).toEqual([])
  })

  it('removes the hooks when turned off and reports nothing installed', async () => {
    hooks.syncAll()
    settings = { ...settings, enabled: false }
    hooks.syncAll()
    for (const a of accounts) {
      expect(existsSync(hookScriptPath(a.configDir))).toBe(false)
      expect(settingsOf(a)).not.toHaveProperty('hooks')
    }
    const status = await hooks.status()
    expect(status.accounts.every((a) => !a.installed && a.problem === null)).toBe(true)
  })

  it('reports invalid settings without touching them and forgets removed accounts', async () => {
    writeFileSync(join(accounts[1].configDir, 'settings.json'), '{ broken')
    hooks.syncAll()
    let status = await hooks.status()
    expect(status.accounts[1]).toMatchObject({ installed: false, problem: 'invalidSettings' })
    expect(readFileSync(join(accounts[1].configDir, 'settings.json'), 'utf8')).toBe('{ broken')

    const [first] = accounts
    hooks.remove(first)
    expect(existsSync(hookScriptPath(first.configDir))).toBe(false)
    accounts = accounts.slice(1)
    hooks.syncAll()
    status = await hooks.status()
    expect(status.accounts.map((a) => a.accountId)).toEqual(['a2'])
  })

  it('records a write failure instead of throwing', async () => {
    const broken: Account = {
      ...accounts[0],
      configDir: join(accounts[0].configDir, 'settings.json', 'x')
    }
    writeFileSync(join(accounts[0].configDir, 'settings.json'), '{}')
    accounts = [broken]
    expect(() => hooks.sync(broken)).not.toThrow()
    const status = await hooks.status()
    expect(status.accounts[0]).toMatchObject({ installed: false, problem: 'writeFailed' })
  })

  it('keeps the hook while the guard is on, without the queue', async () => {
    settings = { ...settings, enabled: false }
    guard = { ...guard, enabled: true }
    hooks.syncAll()
    for (const a of accounts) {
      expect(existsSync(hookScriptPath(a.configDir))).toBe(true)
      expect(Object.keys(settingsOf(a).hooks as object)).toEqual(['PreToolUse'])
    }
    expect((await hooks.status()).accounts.every((a) => a.installed)).toBe(true)
    guard = { ...guard, enabled: false }
    hooks.syncAll()
    for (const a of accounts) expect(settingsOf(a)).not.toHaveProperty('hooks')
  })
})

/** Folder watching driven by the test: `fire(dir, name)` stands for a change event. */
function fakeWatch(): WatchFs & { fire(dir: string, name: string | null): void; dirs(): string[] } {
  const watchers = new Map<string, (name: string | null) => void>()
  return {
    watch(dir, onChange) {
      watchers.set(dir, onChange)
      return { close: () => watchers.delete(dir) }
    },
    fire(dir, name) {
      watchers.get(dir)?.(name)
    },
    dirs: () => [...watchers.keys()].sort()
  }
}

describe('createClaudeDeckHooks: key file and tamper check', () => {
  const identity = { pid: 4242, startTime: 'Fri Oct 9 02:53:46 2026' }

  it("writes the server URL and ClaudeDeck's process into the key file, queue only too", () => {
    const keys = createGuardKeys(() => 'a'.repeat(64))
    const own = createClaudeDeckHooks({
      accounts: () => accounts,
      projects: () => [],
      settings: () => ({ guard, testQueue: settings }),
      lastCallAt: () => null,
      host: mac,
      fs: emptyFs,
      keys,
      hookUrl: () => 'http://127.0.0.1:4000/hooks/',
      identity: () => identity
    })
    own.sync(accounts[0])
    expect(readFileSync(guardKeyPath(accounts[0].configDir), 'utf8')).toBe(
      `${'a'.repeat(64)}\nhttp://127.0.0.1:4000/hooks/\n4242\nFri Oct 9 02:53:46 2026\n`
    )
  })

  it('reports a guard that is on while its server is not running', async () => {
    guard = { ...guard, enabled: true }
    let url: string | null = null
    const own = createClaudeDeckHooks({
      accounts: () => accounts,
      projects: () => [],
      settings: () => ({ guard, testQueue: settings }),
      lastCallAt: () => null,
      host: mac,
      fs: emptyFs,
      hookUrl: () => url
    })
    expect((await own.status()).guardUnavailable).toBe(true)
    url = 'http://127.0.0.1:4000/hooks/'
    expect((await own.status()).guardUnavailable).toBe(false)
    guard = { ...guard, enabled: false }
    url = null
    expect((await own.status()).guardUnavailable).toBe(false)
  })

  it('puts changed hook files back while the guard is on and reports it once', async () => {
    vi.useFakeTimers()
    try {
      guard = { ...guard, enabled: true }
      const watch = fakeWatch()
      const tampered: string[][] = []
      const project: Project = {
        id: 'p1',
        name: 'p1',
        path: mkdtempSync(join(tmpdir(), 'cd-project-')),
        accountId: 'a1'
      }
      projects = [project]
      const notices: { file: string; hooksDisabled: boolean }[] = []
      const own = createClaudeDeckHooks({
        accounts: () => accounts,
        projects: () => projects,
        settings: () => ({ guard, testQueue: settings }),
        lastCallAt: () => null,
        host: mac,
        fs: nodeHookStatusFs,
        keys: createGuardKeys(),
        hookUrl: () => 'http://127.0.0.1:4000/hooks/',
        identity: () => identity,
        watch,
        debounceMs: 10,
        onTamper: (_account, files) => tampered.push(files),
        onProjectConfig: (_project, change) => notices.push(change)
      })
      own.syncAll()
      const [a1] = accounts
      expect(watch.dirs()).toContain(a1.configDir)
      expect(watch.dirs()).toContain(join(a1.configDir, 'claudedeck'))
      expect(watch.dirs()).toContain(project.path)

      // Our own writes: nothing to report.
      watch.fire(a1.configDir, 'settings.json')
      await vi.advanceTimersByTimeAsync(20)
      expect(tampered).toEqual([])

      const key = readFileSync(guardKeyPath(a1.configDir), 'utf8')
      const script = readFileSync(hookScriptPath(a1.configDir), 'utf8')
      writeFileSync(hookScriptPath(a1.configDir), 'exit 0\n')
      writeFileSync(guardKeyPath(a1.configDir), 'x\n')
      writeFileSync(join(a1.configDir, 'settings.json'), '{"disableAllHooks":true}')
      watch.fire(join(a1.configDir, 'claudedeck'), 'hook.sh')
      watch.fire(a1.configDir, 'settings.json')
      await vi.advanceTimersByTimeAsync(20)
      expect(tampered).toHaveLength(1)
      expect(tampered[0].join(' ')).toContain('disableAllHooks')
      // Back as ClaudeDeck wrote them, with the same key (no rotation).
      expect(readFileSync(hookScriptPath(a1.configDir), 'utf8')).toBe(script)
      expect(readFileSync(guardKeyPath(a1.configDir), 'utf8')).toBe(key)
      expect(settingsOf(a1).hooks).toHaveProperty('PreToolUse')
      // Unrelated files in the account folder are not checked.
      watch.fire(a1.configDir, 'CLAUDE.md')
      await vi.advanceTimersByTimeAsync(20)
      expect(tampered).toHaveLength(1)

      // A project switching hooks off: one notice.
      mkdirSync(join(project.path, '.claude'))
      writeFileSync(
        join(project.path, '.claude', 'settings.local.json'),
        '{"disableAllHooks":true}'
      )
      watch.fire(project.path, '.claude')
      await vi.advanceTimersByTimeAsync(20)
      expect(notices).toEqual([{ file: join(project.path, '.claude'), hooksDisabled: true }])
      watch.fire(join(project.path, '.claude'), 'settings.local.json')
      await vi.advanceTimersByTimeAsync(20)
      expect(notices).toHaveLength(1)

      // Guard off: nothing is watched.
      guard = { ...guard, enabled: false }
      own.syncAll()
      expect(watch.dirs()).toEqual([])
      own.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
