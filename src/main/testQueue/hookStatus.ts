import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { Account, Project } from '../../shared/types'
import { WIN_DEFAULT_SYSTEM_ROOT } from '../platform/constants'
import type { RunFile } from '../platform/processList'
import type { OsName } from '../platform/types'
import { isObject, type Json, settingsPath } from '../profile/settingsFile'

const MANAGED_FILE = 'managed-settings.json'
const MANAGED_DIR = 'managed-settings.d'
const MDM_DOMAIN = 'com.anthropic.claudecode'
const POLICY_KEYS = ['HKLM\\SOFTWARE\\Policies\\ClaudeCode', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode']
const MAX_SETTINGS_BYTES = 1024 * 1024

/** File access of the detection; tests pass fakes. */
export interface HookStatusFs {
  /** Parsed JSON object; undefined when missing, null when unreadable or not an object. */
  readJson(path: string): Json | null | undefined
  /** File names in a folder; empty when it does not exist. */
  list(dir: string): string[]
  exists(path: string): boolean
}

export const nodeHookStatusFs: HookStatusFs = {
  readJson(path) {
    if (!existsSync(path)) return undefined
    try {
      const text = readFileSync(path, 'utf8')
      if (text.length > MAX_SETTINGS_BYTES) return null
      const json: unknown = JSON.parse(text)
      return isObject(json) ? json : null
    } catch {
      return null
    }
  },
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  exists: existsSync
}

/** Managed settings folder of each OS (verified paths, Claude Code 2.1.282). */
export function managedSettingsDir(os: OsName, env: Record<string, string | undefined>): string {
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (os === 'win32') {
    return nodePath.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
  }
  return '/etc/claude-code'
}

/** Top-level flags that keep ClaudeDeck's hooks from running; policy disableAllHooks implies it. */
const blocksUserHooks = (settings: Json | null | undefined): boolean =>
  !!settings && (settings.allowManagedHooksOnly === true || settings.disableAllHooks === true)

/** managed-settings.json and every `*.json` in managed-settings.d. */
export function managedSettingsFiles(
  os: OsName,
  env: Record<string, string | undefined>,
  fs: HookStatusFs
): string[] {
  const p = os === 'win32' ? nodePath.win32 : nodePath.posix
  const dir = managedSettingsDir(os, env)
  const dropIns = p.join(dir, MANAGED_DIR)
  return [
    p.join(dir, MANAGED_FILE),
    ...fs
      .list(dropIns)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => p.join(dropIns, name))
  ]
}

/** `reg query` output: a policy value (DWORD or string, or JSON text) that blocks our hooks. */
export function registryBlocksHooks(text: string): boolean {
  if (/"(disableAllHooks|allowManagedHooksOnly)"\s*:\s*true/.test(text)) return true
  return /^\s*(disableAllHooks|allowManagedHooksOnly)\s+REG_\w+\s+(0x0*1|1|true)\s*$/im.test(text)
}

/** Managed sources set `allowManagedHooksOnly` or `disableAllHooks`. Best effort for MDM. */
export async function managedHooksOnly(opts: {
  os: OsName
  env: Record<string, string | undefined>
  fs: HookStatusFs
  run?: RunFile
}): Promise<boolean> {
  const { os, env, fs, run } = opts
  if (managedSettingsFiles(os, env, fs).some((file) => blocksUserHooks(fs.readJson(file)))) {
    return true
  }
  if (!run) return false
  if (os === 'darwin') {
    const user = env.USER && /^[\w.-]+$/.test(env.USER) ? env.USER : null
    const plists = [
      `/Library/Managed Preferences/${MDM_DOMAIN}.plist`,
      ...(user ? [`/Library/Managed Preferences/${user}/${MDM_DOMAIN}.plist`] : [])
    ]
    for (const plist of plists) {
      if (!fs.exists(plist)) continue
      try {
        const json: unknown = JSON.parse(
          await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
        )
        if (isObject(json) && blocksUserHooks(json)) return true
      } catch {
        // Unreadable profile: no answer from this source.
      }
    }
  }
  if (os === 'win32') {
    const reg = nodePath.win32.join(
      env.SystemRoot || WIN_DEFAULT_SYSTEM_ROOT,
      'System32',
      'reg.exe'
    )
    for (const key of POLICY_KEYS) {
      try {
        if (registryBlocksHooks(await run(reg, ['query', key, '/s']))) return true
      } catch {
        // Key missing (reg exits 1) or reg unavailable.
      }
    }
  }
  return false
}

/** Effective `disableAllHooks` of a project: local, then project, then the account's settings. */
export function projectHooksDisabled(
  projectPath: string,
  accountSettings: Json | null | undefined,
  fs: HookStatusFs,
  os: OsName = process.platform
): boolean {
  const p = os === 'win32' ? nodePath.win32 : nodePath.posix
  const sources = [
    fs.readJson(p.join(projectPath, '.claude', 'settings.local.json')),
    fs.readJson(p.join(projectPath, '.claude', 'settings.json')),
    accountSettings
  ]
  for (const settings of sources) {
    if (settings && typeof settings.disableAllHooks === 'boolean') return settings.disableAllHooks
  }
  return false
}

/** Projects whose tabs would not run ClaudeDeck's hooks. */
export function hooksDisabledProjects(
  projects: Project[],
  accounts: Account[],
  fs: HookStatusFs = nodeHookStatusFs,
  os: OsName = process.platform
): string[] {
  const accountSettings = new Map(
    accounts.map((a) => [a.id, fs.readJson(settingsPath(a.configDir))] as const)
  )
  return projects
    .filter((project) =>
      projectHooksDisabled(project.path, accountSettings.get(project.accountId), fs, os)
    )
    .map((project) => project.id)
}
