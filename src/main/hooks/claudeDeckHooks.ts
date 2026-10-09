import * as nodePath from 'node:path'
import type {
  Account,
  GuardSettings,
  Project,
  TestQueueHookStatus,
  TestQueueSettings
} from '../../shared/types'
import type { RunFile } from '../platform/processList'
import { settingsPath } from '../profile/settingsFile'
import type { GuardKeys } from './guardKeys'
import {
  currentHookHost,
  type HookFeatures,
  type HookHost,
  type HookInstallResult,
  installHooks,
  removeHooks
} from './hookInstaller'
import {
  hooksDisabledProjects,
  managedHooksOnly,
  nodeHookStatusFs,
  projectHooksDisabled,
  type HookStatusFs
} from './hookStatus'
import { createWatchGroup, nodeWatchFs, type WatchFs } from './hookWatch'
import type { ProcessIdentity } from './processIdentity'

export interface ClaudeDeckHooksDeps {
  accounts(): Account[]
  projects(): Project[]
  settings(): { guard: GuardSettings; testQueue: TestQueueSettings }
  lastCallAt(accountId: string): number | null
  host?: HookHost
  fs?: HookStatusFs
  /** Best effort MDM / registry policy reads; omitted in tests. */
  run?: RunFile
  /** Guard keys: a fresh one is written next to the script on every sync. */
  keys?: GuardKeys
  /** Hook base URL of the running server (written with the key); null when it is not running. */
  hookUrl?: () => string | null
  /** ClaudeDeck's process, written with the key so the script can tell it is still running. */
  identity?: () => ProcessIdentity
  /** Folder watching for the tamper check; omitted, nothing is watched. */
  watch?: WatchFs
  /**
   * ClaudeDeck's hook files or an account's settings changed behind its back while the guard is
   * on (and were put back); `files` names what changed.
   */
  onTamper?: (account: Account, files: string[]) => void
  /** A project's Claude settings or MCP servers changed while the guard is on. */
  onProjectConfig?: (project: Project, change: { file: string; hooksDisabled: boolean }) => void
  /** Wait after a change before checking (several events come for one write). */
  debounceMs?: number
}

export interface ClaudeDeckHooks {
  /** Installs or removes the hooks of one account to match the settings. */
  sync(account: Account): void
  syncAll(): void
  /** Takes the hooks out of an account that is going away. */
  remove(account: Account): void
  /**
   * Puts ClaudeDeck's hook files and settings back when they differ from what it wrote (same
   * key, no rotation). True when something had to be rewritten.
   */
  verify(account: Account): boolean
  status(): Promise<TestQueueHookStatus>
  /** Stops watching (app quit). */
  stop(): void
}

/** Names in an account folder that hold ClaudeDeck's hook or the settings pointing at it. */
const ACCOUNT_FILES = new Set(['settings.json', 'claudedeck'])
/** Project files that can turn hooks off or add hooks and MCP servers. */
const PROJECT_FILES = /^(settings.*\.json|\.mcp\.json|\.claude)$/i

/**
 * Keeps every account's settings.json in line with `guard.enabled` and `testQueue.enabled`
 * (the hook is installed while either is on) and remembers the results. While the guard is on,
 * the hook files and settings are watched and put back when changed by something else, and
 * project settings that could switch hooks off are watched for a notice.
 */
export function createClaudeDeckHooks(deps: ClaudeDeckHooksDeps): ClaudeDeckHooks {
  const host = deps.host ?? currentHookHost()
  const fs = deps.fs ?? nodeHookStatusFs
  const p = host.os === 'win32' ? nodePath.win32 : nodePath.posix
  const results = new Map<string, HookInstallResult>()
  /** Features last installed per account: the tamper check writes the same again. */
  const installed = new Map<string, HookFeatures>()
  /** Accounts whose settings disable all hooks (reported once per change). */
  const disabled = new Set<string>()
  const accountWatch = createWatchGroup(deps.watch ?? nodeWatchFs)
  const projectWatch = createWatchGroup(deps.watch ?? nodeWatchFs)
  const projectPrints = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const debounceMs = deps.debounceMs ?? 150

  const later = (key: string, fn: () => void): void => {
    const before = timers.get(key)
    if (before) clearTimeout(before)
    const timer = setTimeout(() => {
      timers.delete(key)
      try {
        fn()
      } catch (error) {
        console.warn('[hooks] watch check failed', error)
      }
    }, debounceMs)
    ;(timer as { unref?: () => void }).unref?.()
    timers.set(key, timer)
  }

  const features = (account: Account): HookFeatures => {
    const { guard, testQueue } = deps.settings()
    const on = guard.enabled || testQueue.enabled
    const identity = deps.identity?.()
    return {
      guard: guard.enabled,
      queue: testQueue.enabled,
      maxWaitMinutes: testQueue.maxWaitMinutes,
      ...(on && deps.keys
        ? {
            guardKey: {
              key: deps.keys.rotate(account.id),
              url: deps.hookUrl?.() ?? null,
              pid: identity?.pid ?? null,
              startTime: identity?.startTime ?? null
            }
          }
        : {})
    }
  }

  const sync = (account: Account): void => {
    let result: HookInstallResult
    const wanted = features(account)
    try {
      result = installHooks(account.configDir, wanted, host)
    } catch (error) {
      console.warn('[hooks] hook sync failed', account.id, error)
      result = { installed: false, problem: 'writeFailed', changed: false }
    }
    if (result.problem) console.warn('[hooks]', account.id, result.problem)
    results.set(account.id, result)
    if (result.installed) installed.set(account.id, wanted)
    else installed.delete(account.id)
    refreshWatches()
  }

  /** Account settings that switch every hook off (ours included). */
  const checkDisabled = (account: Account): string[] => {
    const settings = fs.readJson(settingsPath(account.configDir))
    const off = !!settings && settings.disableAllHooks === true
    if (!off) {
      disabled.delete(account.id)
      return []
    }
    if (disabled.has(account.id)) return []
    disabled.add(account.id)
    return ['settings.json (disableAllHooks)']
  }

  const verify = (account: Account): boolean => {
    const wanted = installed.get(account.id)
    if (!wanted || !deps.settings().guard.enabled) return false
    let result: HookInstallResult
    try {
      result = installHooks(account.configDir, wanted, host)
    } catch (error) {
      console.warn('[hooks] hook check failed', account.id, error)
      return false
    }
    const files = result.changed
      ? ['claudedeck/hook.sh, claudedeck/guard.key or settings.json']
      : []
    files.push(...checkDisabled(account))
    if (files.length) deps.onTamper?.(account, files)
    return result.changed
  }

  /** What in a project can switch hooks off or add hooks and MCP servers. */
  const projectPrint = (project: Project): string => {
    const dir = p.join(project.path, '.claude')
    const pick = (file: string): unknown => {
      const json = fs.readJson(file)
      return json ? { off: json.disableAllHooks, hooks: json.hooks } : (json ?? null)
    }
    const names = fs
      .list(dir)
      .filter((n) => /^settings.*\.json$/i.test(n))
      .sort()
    const mcp = fs.readJson(p.join(project.path, '.mcp.json'))
    return JSON.stringify({
      settings: names.map((n) => [n, pick(p.join(dir, n))]),
      mcp: mcp && typeof mcp.mcpServers === 'object' ? Object.keys(mcp.mcpServers ?? {}) : null
    })
  }

  const checkProject = (project: Project): void => {
    const print = projectPrint(project)
    const before = projectPrints.get(project.id)
    projectPrints.set(project.id, print)
    if (before === undefined || before === print) return
    const accounts = deps.accounts()
    const account = accounts.find((a) => a.id === project.accountId)
    const accountSettings = account ? fs.readJson(settingsPath(account.configDir)) : undefined
    deps.onProjectConfig?.(project, {
      file: p.join(project.path, '.claude'),
      hooksDisabled: projectHooksDisabled(project.path, accountSettings, fs, host.os)
    })
  }

  /** Watches the hook files of guarded accounts and the settings of their projects. */
  function refreshWatches(): void {
    if (!deps.watch) return
    const guardOn = deps.settings().guard.enabled
    const accounts = guardOn ? deps.accounts().filter((a) => installed.has(a.id)) : []
    const dirs = new Map<string, (name: string | null) => void>()
    for (const account of accounts) {
      const check = (): void => later(`account:${account.id}`, () => verify(account))
      dirs.set(account.configDir, (name) => {
        if (name === null || ACCOUNT_FILES.has(name)) check()
      })
      dirs.set(p.join(account.configDir, 'claudedeck'), check)
    }
    accountWatch.set(dirs)
    const ids = new Set(accounts.map((a) => a.id))
    const projects = deps.projects().filter((project) => ids.has(project.accountId))
    const projectDirs = new Map<string, (name: string | null) => void>()
    for (const project of projects) {
      if (!projectPrints.has(project.id)) projectPrints.set(project.id, projectPrint(project))
      const check = (name: string | null): void => {
        if (name !== null && !PROJECT_FILES.test(name)) return
        later(`project:${project.id}`, () => {
          checkProject(project)
          // A `.claude` folder created after watching started is watched from now on.
          refreshWatches()
        })
      }
      projectDirs.set(project.path, check)
      projectDirs.set(p.join(project.path, '.claude'), check)
    }
    for (const id of [...projectPrints.keys()]) {
      if (!projects.some((project) => project.id === id)) projectPrints.delete(id)
    }
    projectWatch.set(projectDirs)
  }

  return {
    sync,
    syncAll() {
      const accounts = deps.accounts()
      for (const id of [...results.keys()]) {
        if (!accounts.some((a) => a.id === id)) {
          results.delete(id)
          installed.delete(id)
        }
      }
      accounts.forEach(sync)
    },
    remove(account) {
      deps.keys?.forget(account.id)
      installed.delete(account.id)
      try {
        removeHooks(account.configDir, host.os, host.home)
      } catch (error) {
        console.warn('[hooks] could not remove hooks', account.id, error)
      }
      results.delete(account.id)
      refreshWatches()
    },
    verify,
    async status() {
      refreshWatches()
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
        guardEnabled: guard.enabled,
        // The guard is on but its server is not running: guarded calls of tabs are denied.
        guardUnavailable: guard.enabled && !!deps.hookUrl && deps.hookUrl() === null,
        managedHooksOnly: await managedHooksOnly({ os: host.os, env: host.env, fs, run: deps.run }),
        hooksDisabledProjectIds: hooksDisabledProjects(deps.projects(), accounts, fs, host.os)
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      accountWatch.close()
      projectWatch.close()
    }
  }
}
