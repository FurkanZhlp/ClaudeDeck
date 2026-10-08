import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, GuardSettings, Project, TestQueueSettings } from '../../shared/types'
import { defaultGuardSettings } from '../state/guardSettings'
import { defaultTestQueueSettings } from '../state/testQueueSettings'
import { hookScriptPath, type HookHost } from './hookInstaller'
import type { HookStatusFs } from './hookStatus'
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
