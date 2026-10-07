import type { Account, Project, TestQueueHookStatus, TestQueueSettings } from '../../shared/types'
import type { RunFile } from '../platform/processList'
import {
  currentHookHost,
  type HookHost,
  type HookInstallResult,
  installTestQueueHooks,
  removeTestQueueHooks
} from './hookInstaller'
import {
  hooksDisabledProjects,
  managedHooksOnly,
  nodeHookStatusFs,
  type HookStatusFs
} from './hookStatus'

export interface TestQueueHooksDeps {
  accounts(): Account[]
  projects(): Project[]
  settings(): TestQueueSettings
  lastCallAt(accountId: string): number | null
  host?: HookHost
  fs?: HookStatusFs
  /** Best effort MDM / registry policy reads; omitted in tests. */
  run?: RunFile
}

export interface TestQueueHooks {
  /** Installs or removes the hooks of one account to match the settings. */
  sync(account: Account): void
  syncAll(): void
  /** Takes the hooks out of an account that is going away. */
  remove(account: Account): void
  status(): Promise<TestQueueHookStatus>
}

/** Keeps every account's settings.json in line with `testQueue.enabled` and remembers results. */
export function createTestQueueHooks(deps: TestQueueHooksDeps): TestQueueHooks {
  const host = deps.host ?? currentHookHost()
  const fs = deps.fs ?? nodeHookStatusFs
  const results = new Map<string, HookInstallResult>()

  const sync = (account: Account): void => {
    const settings = deps.settings()
    let result: HookInstallResult
    try {
      result = settings.enabled
        ? installTestQueueHooks(account.configDir, settings.maxWaitMinutes, host)
        : removeTestQueueHooks(account.configDir)
    } catch (error) {
      console.warn('[test-queue] hook sync failed', account.id, error)
      result = { installed: false, problem: 'writeFailed', changed: false }
    }
    if (result.problem) console.warn('[test-queue] hooks', account.id, result.problem)
    results.set(account.id, result)
  }

  return {
    sync,
    syncAll() {
      const accounts = deps.accounts()
      for (const id of [...results.keys()]) {
        if (!accounts.some((a) => a.id === id)) results.delete(id)
      }
      accounts.forEach(sync)
    },
    remove(account) {
      try {
        removeTestQueueHooks(account.configDir)
      } catch (error) {
        console.warn('[test-queue] could not remove hooks', account.id, error)
      }
      results.delete(account.id)
    },
    async status() {
      const accounts = deps.accounts()
      const enabled = deps.settings().enabled
      return {
        accounts: accounts.map((a) => {
          const result = results.get(a.id)
          return {
            accountId: a.id,
            installed: enabled && !!result?.installed,
            lastCallAt: deps.lastCallAt(a.id),
            problem: enabled ? (result?.problem ?? null) : null
          }
        }),
        managedHooksOnly: await managedHooksOnly({ os: host.os, env: host.env, fs, run: deps.run }),
        hooksDisabledProjectIds: hooksDisabledProjects(deps.projects(), accounts, fs, host.os)
      }
    }
  }
}
