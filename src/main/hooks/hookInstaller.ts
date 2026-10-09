import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import type { TestQueueHookProblem } from '../../shared/types'
import type { OsName } from '../platform/types'
import {
  isObject,
  type Json,
  readSettings,
  settingsPath,
  updateSettings
} from '../profile/settingsFile'
import { writeFileAtomic } from '../profile/guidelines'
import { findGitBash } from '../usage/statuslineScript'
import {
  GUARD_HOOK_TIMEOUT_SECONDS,
  GUARD_KEY_FILE,
  GUARD_MATCHER,
  guardKeyFile,
  HOOK_SCRIPT_FILE,
  hookCommand,
  hookScript,
  LEGACY_HOOK_SCRIPT_FILE,
  OURS,
  POST_HOOK_TIMEOUT_SECONDS,
  preHookTimeout,
  QUEUE_MATCHER,
  type HookEvent
} from './hookScript'

const SCRIPT_MODE = 0o755

/** settings.json hook events ClaudeDeck adds a group to, with the script event they call. */
export const HOOK_EVENTS: readonly (readonly [string, HookEvent])[] = [
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['PostToolUseFailure', 'post']
]

export const hookScriptPath = (configDir: string): string =>
  join(configDir, 'claudedeck', HOOK_SCRIPT_FILE)

export const guardKeyPath = (configDir: string): string =>
  join(configDir, 'claudedeck', GUARD_KEY_FILE)

const KEY_MODE = 0o600
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * Writes `content` unless the file is a regular file with exactly this content (compared by
 * hash). A symlink or anything else in its place is replaced, never written through.
 */
export function writeVerified(file: string, content: string, mode: number): boolean {
  try {
    const stat = lstatSync(file)
    if (stat.isFile() && sha256(readFileSync(file)) === sha256(content)) return false
  } catch {
    // Missing: written below.
  }
  writeFileAtomic(file, content, mode)
  return true
}

const legacyScriptPath = (configDir: string): string =>
  join(configDir, 'claudedeck', LEGACY_HOOK_SCRIPT_FILE)

/** What the hook is installed for. */
export interface HookFeatures {
  /** Command guard on: PreToolUse for every guarded tool, fail closed. */
  guard: boolean
  /** Test queue on: PreToolUse and PostToolUse(Failure) for Bash and PowerShell. */
  queue: boolean
  /** Test queue max wait (pre hook timeout and poll count). */
  maxWaitMinutes: number
  /**
   * The key file: guard key, hook base URL (the script's only source for it) and ClaudeDeck's
   * process (pid and start time), written while the hook is installed.
   */
  guardKey?: { key: string; url: string | null; pid?: number | null; startTime?: string | null }
}

/** Where the hooks are installed; tests pass a Windows host on a Mac. */
export interface HookHost {
  os: OsName
  env: Record<string, string | undefined>
  exists?: (path: string) => boolean
  /** Home folder for the `~/` permission rules; the current user's by default. */
  home?: string
}

export const currentHookHost = (): HookHost => ({ os: process.platform, env: process.env })

/**
 * `permissions.deny` Read rules ClaudeDeck adds to an account's settings while the guard is on:
 * private keys, credential files and the account's guard key. Claude Code applies them in every
 * permission mode, next to the hook's own Read check.
 */
export function secretReadRules(configDir: string, host: HookHost): string[] {
  const p = host.os === 'win32' ? nodePath.win32 : nodePath.posix
  const home = host.home ?? homedir()
  const key = p.join(configDir, 'claudedeck', GUARD_KEY_FILE)
  const rel = p.relative(home, key)
  const inHome = rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)
  const keyRule = inHome
    ? `~/${rel.split(p.sep).join('/')}`
    : `//${key
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^([A-Za-z]):/, '$1')}`
  return [
    'Read(~/.ssh/id_*)',
    'Read(~/.aws/credentials)',
    'Read(~/.gnupg/private-keys-v1.d/**)',
    'Read(~/.gnupg/secring.gpg)',
    `Read(${keyRule})`
  ]
}

/**
 * New `permissions` value with our deny rules replaced (`add`) or removed; undefined when the
 * key ends up absent, null when the existing value has a shape we must not touch.
 */
function nextPermissions(
  current: unknown,
  add: readonly string[] | null,
  ours: ReadonlySet<string>
): Json | undefined | null {
  if (current !== undefined && !isObject(current)) return null
  const deny = current?.deny
  if (deny !== undefined && !Array.isArray(deny)) return null
  const kept = (deny ?? []).filter((rule) => typeof rule !== 'string' || !ours.has(rule))
  const next = add ? [...kept, ...add.filter((rule) => !kept.includes(rule))] : kept
  if (current === undefined) return next.length ? { deny: next } : undefined
  const out: Json = { ...current }
  if (next.length) out.deny = next
  // A list that only held our rules goes with them (and an object left empty too).
  else if (deny !== undefined && deny.length > 0) delete out.deny
  return Object.keys(out).length ? out : undefined
}

/** Settings with our deny rules added or removed (unchanged when `permissions` is odd). */
function withPermissions(
  settings: Json,
  add: readonly string[] | null,
  ours: ReadonlySet<string>
): Json {
  const permissions = nextPermissions(settings.permissions, add, ours)
  if (permissions === null) return settings
  const next = { ...settings }
  if (permissions === undefined) delete next.permissions
  else next.permissions = permissions
  return next
}

export interface HookInstallResult {
  installed: boolean
  problem: TestQueueHookProblem | null
  /** settings.json or the script changed. */
  changed: boolean
}

/**
 * Commands ClaudeDeck writes for this account's scripts (old script names included), in the
 * POSIX and the Git Bash (forward slashes) form.
 */
const ourCommands = (configDir: string, os: OsName): Set<string> =>
  new Set(
    [hookScriptPath(configDir), legacyScriptPath(configDir)].flatMap((path) =>
      (['pre', 'post'] as const).flatMap((event) => [
        hookCommand(path, event, os),
        hookCommand(path, event, 'win32'),
        hookCommand(path, event, 'darwin')
      ])
    )
  )

/** Exactly our generated command; a look-alike that only mentions the path is the user's. */
const isOurHook = (hook: unknown, ours: ReadonlySet<string>): boolean =>
  isObject(hook) &&
  typeof hook.command === 'string' &&
  OURS.test(hook.command) &&
  ours.has(hook.command)

/**
 * Event groups without ClaudeDeck's hooks. Our hooks are dropped from every group; a group left
 * empty by that is dropped too. Anything else stays exactly as it was.
 */
function withoutOurs(groups: unknown[], ours: ReadonlySet<string>): unknown[] {
  const out: unknown[] = []
  for (const group of groups) {
    if (
      !isObject(group) ||
      !Array.isArray(group.hooks) ||
      !group.hooks.some((h) => isOurHook(h, ours))
    ) {
      out.push(group)
      continue
    }
    const hooks = group.hooks.filter((h) => !isOurHook(h, ours))
    if (hooks.length > 0) out.push({ ...group, hooks })
  }
  return out
}

/** Our group for one settings event, or null when the features need none there. */
function ourGroup(
  scriptPath: string,
  event: HookEvent,
  os: OsName,
  features: HookFeatures
): Json | null {
  const command = hookCommand(scriptPath, event, os)
  if (event === 'post') {
    if (!features.queue) return null
    const hook = { type: 'command', command, timeout: POST_HOOK_TIMEOUT_SECONDS, async: true }
    return { matcher: QUEUE_MATCHER, hooks: [hook] }
  }
  const timeout = features.queue
    ? preHookTimeout(features.maxWaitMinutes)
    : GUARD_HOOK_TIMEOUT_SECONDS
  return {
    matcher: features.guard ? GUARD_MATCHER : QUEUE_MATCHER,
    hooks: [{ type: 'command', command, timeout }]
  }
}

/**
 * New `hooks` value with our groups replaced (`install`) or removed; null when the existing
 * value has a shape we must not touch (not an object, or an event that is not an array).
 */
function nextHooks(
  current: unknown,
  add: ((event: HookEvent) => Json | null) | null,
  ours: ReadonlySet<string>
): Json | null {
  if (current !== undefined && !isObject(current)) return null
  const hooks: Json = { ...(current ?? {}) }
  for (const [name, event] of HOOK_EVENTS) {
    const existing = hooks[name]
    if (existing !== undefined && !Array.isArray(existing)) return null
    const kept = withoutOurs(existing ?? [], ours)
    const group = add ? add(event) : null
    if (group) hooks[name] = [...kept, group]
    else if (kept.length > 0) hooks[name] = kept
    else if (existing !== undefined) delete hooks[name]
  }
  return hooks
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Adds ClaudeDeck's hook groups to the account's settings.json and writes the script; groups
 * and scripts of older versions (`test-queue.sh`) are replaced. Idempotent; the user's own
 * hooks are kept as they are. Windows without Git Bash gets no hook (the script needs a POSIX
 * shell). Invalid settings.json is never touched.
 */
export function installHooks(
  configDir: string,
  features: HookFeatures,
  host: HookHost = currentHookHost()
): HookInstallResult {
  if (!features.guard && !features.queue) return removeHooks(configDir, host.os, host.home)
  if (host.os === 'win32' && !findGitBash(host.env, host.exists)) {
    const removed = removeHooks(configDir, host.os, host.home)
    return { installed: false, problem: 'noGitBash', changed: removed.changed }
  }
  const file = settingsPath(configDir)
  const scriptPath = hookScriptPath(configDir)
  const rules = secretReadRules(configDir, host)
  const withOurs = (settings: Json): Json | null => {
    const hooks = nextHooks(
      settings.hooks,
      (event) => ourGroup(scriptPath, event, host.os, features),
      ourCommands(configDir, host.os)
    )
    if (!hooks) return null
    return withPermissions({ ...settings, hooks }, features.guard ? rules : null, new Set(rules))
  }
  // Checked before anything is written; the update below checks again on the fresh file.
  const current = readSettings(file)
  if (!current || !withOurs(current)) {
    return { installed: false, problem: 'invalidSettings', changed: false }
  }

  try {
    mkdirSync(join(configDir, 'claudedeck'), { recursive: true })
    // The script first: a hook pointing at a missing file would fail every Bash call's hook.
    const script = hookScript({
      guard: features.guard,
      maxWaitMinutes: features.maxWaitMinutes,
      os: host.os
    })
    let changed = writeVerified(scriptPath, script, SCRIPT_MODE)
    const keyFile = guardKeyPath(configDir)
    if (features.guardKey) {
      changed = writeVerified(keyFile, guardKeyFile(features.guardKey), KEY_MODE) || changed
    } else if (existsSync(keyFile)) {
      rmSync(keyFile, { force: true })
      changed = true
    }
    const result = updateSettings(file, (settings) => {
      const next = withOurs(settings)
      if (!next) return 'invalid'
      return sameJson(settings.hooks, next.hooks) &&
        sameJson(settings.permissions, next.permissions)
        ? 'unchanged'
        : next
    })
    if (result === 'invalid') return { installed: false, problem: 'invalidSettings', changed }
    if (result === 'written') changed = true
    // settings.json no longer points at the old script.
    if (existsSync(legacyScriptPath(configDir))) {
      rmSync(legacyScriptPath(configDir), { force: true })
      changed = true
    }
    return { installed: true, problem: null, changed }
  } catch (error) {
    console.warn('[hooks] could not install hooks', error)
    return { installed: false, problem: 'writeFailed', changed: false }
  }
}

/** Removes ClaudeDeck's groups (only those), the scripts (old names included) and the key. */
export function removeHooks(
  configDir: string,
  os: OsName = process.platform,
  home?: string
): HookInstallResult {
  const file = settingsPath(configDir)
  const rules = new Set(secretReadRules(configDir, { os, env: {}, home }))
  let changed = false
  let problem: TestQueueHookProblem | null = null
  try {
    if (existsSync(file)) {
      const result = updateSettings(file, (settings) => {
        let next = withPermissions(settings, null, rules)
        if (settings.hooks !== undefined) {
          const hooks = nextHooks(settings.hooks, null, ourCommands(configDir, os))
          if (!hooks) return 'invalid'
          next = { ...next }
          if (Object.keys(hooks).length > 0) next.hooks = hooks
          else delete next.hooks
        }
        return sameJson(settings, next) ? 'unchanged' : next
      })
      if (result === 'invalid') problem = 'invalidSettings'
      if (result === 'written') changed = true
    }
    for (const script of [
      hookScriptPath(configDir),
      legacyScriptPath(configDir),
      guardKeyPath(configDir)
    ]) {
      if (existsSync(script)) {
        rmSync(script, { force: true })
        changed = true
      }
    }
  } catch (error) {
    console.warn('[hooks] could not remove hooks', error)
    problem = 'writeFailed'
  }
  return { installed: false, problem, changed }
}
