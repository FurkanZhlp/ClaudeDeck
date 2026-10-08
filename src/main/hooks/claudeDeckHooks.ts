import type {
  Account,
  GuardSettings,
  Project,
  TestQueueHookStatus,
  TestQueueSettings
} from '../../shared/types'
import type { RunFile } from '../platform/processList'
import {
  currentHookHost,
  type HookHost,
  type HookInstallResult,
  installHooks,
  removeHooks
} from './hookInstaller'
import {
  hooksDisabledProjects,
  managedHooksOnly,
  nodeHookStatusFs,
  type HookStatusFs
} from './hookStatus'

export interface ClaudeDeckHooksDeps {
  accounts(): Account[]
  projects(): Project[]
  settings(): { guard: GuardSettings; testQueue: TestQueueSettings }
  lastCallAt(accountId: string): number | null
  host?: HookHost
  fs?: HookStatusFs
  /** Best effort MDM / registry policy reads; omitted in tests. */
  run?: RunFile
}

export interface ClaudeDeckHooks {
  /** Installs or removes the hooks of one account to match the settings. */
  sync(account: Account): void
  syncAll(): void
  /** Takes the hooks out of an account that is going away. */
  remove(account: Account): void
  status(): Promise<TestQueueHookStatus>
}

/**
 * Keeps every account's settings.json in line with `guard.enabled` and `testQueue.enabled`
 * (the hook is installed while either is on) and remembers the results.
 */
export function createClaudeDeckHooks(deps: ClaudeDeckHooksDeps): ClaudeDeckHooks {
  const host = deps.host ?? currentHookHost()
  const fs = deps.fs ?? nodeHookStatusFs
  const results = new Map<string, HookInstallResult>()

  const sync = (account: Account): void => {
    const { guard, testQueue } = deps.settings()
    let result: HookInstallResult
    try {
      result = installHooks(
        account.configDir,
        {
          guard: guard.enabled,
          queue: testQueue.enabled,
          maxWaitMinutes: testQueue.maxWaitMinutes
        },
        host
      )
    } catch (error) {
      console.warn('[hooks] hook sync failed', account.id, error)
      result = { installed: false, problem: 'writeFailed', changed: false }
    }
    if (result.problem) console.warn('[hooks]', account.id, result.problem)
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
        removeHooks(account.configDir)
      } catch (error) {
        console.warn('[hooks] could not remove hooks', account.id, error)
      }
      results.delete(account.id)
    },
    async status() {
      const accounts = deps.accounts()
      const { guard, testQueue } = deps.settings()
      const enabled = guard.enabled || testQueue.enabled
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
