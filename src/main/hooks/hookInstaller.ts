import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TestQueueHookProblem } from '../../shared/types'
import type { OsName } from '../platform/types'
import {
  isObject,
  type Json,
  readSettings,
  settingsPath,
  updateSettings,
  writeIfChanged
} from '../profile/settingsFile'
import { findGitBash } from '../usage/statuslineScript'
import {
  GUARD_HOOK_TIMEOUT_SECONDS,
  GUARD_MATCHER,
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
}

/** Where the hooks are installed; tests pass a Windows host on a Mac. */
export interface HookHost {
  os: OsName
  env: Record<string, string | undefined>
  exists?: (path: string) => boolean
}

export const currentHookHost = (): HookHost => ({ os: process.platform, env: process.env })

export interface HookInstallResult {
  installed: boolean
  problem: TestQueueHookProblem | null
  /** settings.json or the script changed. */
  changed: boolean
}

const isOurHook = (hook: unknown): boolean =>
  isObject(hook) && typeof hook.command === 'string' && OURS.test(hook.command)

/**
 * Event groups without ClaudeDeck's hooks. Our hooks are dropped from every group; a group left
 * empty by that is dropped too. Anything else stays exactly as it was.
 */
function withoutOurs(groups: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurHook)) {
      out.push(group)
      continue
    }
    const hooks = group.hooks.filter((h) => !isOurHook(h))
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
function nextHooks(current: unknown, add: ((event: HookEvent) => Json | null) | null): Json | null {
  if (current !== undefined && !isObject(current)) return null
  const hooks: Json = { ...(current ?? {}) }
  for (const [name, event] of HOOK_EVENTS) {
    const existing = hooks[name]
    if (existing !== undefined && !Array.isArray(existing)) return null
    const kept = withoutOurs(existing ?? [])
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
  if (!features.guard && !features.queue) return removeHooks(configDir)
  if (host.os === 'win32' && !findGitBash(host.env, host.exists)) {
    const removed = removeHooks(configDir)
    return { installed: false, problem: 'noGitBash', changed: removed.changed }
  }
  const file = settingsPath(configDir)
  const scriptPath = hookScriptPath(configDir)
  const withOurs = (settings: Json): Json | null => {
    const hooks = nextHooks(settings.hooks, (event) =>
      ourGroup(scriptPath, event, host.os, features)
    )
    return hooks && { ...settings, hooks }
  }
  // Checked before anything is written; the update below checks again on the fresh file.
  const current = readSettings(file)
  if (!current || !withOurs(current)) {
    return { installed: false, problem: 'invalidSettings', changed: false }
  }

  try {
    mkdirSync(join(configDir, 'claudedeck'), { recursive: true })
    // The script first: a hook pointing at a missing file would fail every Bash call's hook.
    const script = hookScript({ guard: features.guard, maxWaitMinutes: features.maxWaitMinutes })
    let changed = writeIfChanged(scriptPath, script, SCRIPT_MODE)
    const result = updateSettings(file, (settings) => {
      const next = withOurs(settings)
      if (!next) return 'invalid'
      return sameJson(settings.hooks, next.hooks) ? 'unchanged' : next
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

/** Removes ClaudeDeck's groups (only those) and the scripts, old names included. */
export function removeHooks(configDir: string): HookInstallResult {
  const file = settingsPath(configDir)
  let changed = false
  let problem: TestQueueHookProblem | null = null
  try {
    if (existsSync(file)) {
      const result = updateSettings(file, (settings) => {
        if (settings.hooks === undefined) return 'unchanged'
        const hooks = nextHooks(settings.hooks, null)
        if (!hooks) return 'invalid'
        if (sameJson(settings.hooks, hooks)) return 'unchanged'
        const next = { ...settings }
        if (Object.keys(hooks).length > 0) next.hooks = hooks
        else delete next.hooks
        return next
      })
      if (result === 'invalid') problem = 'invalidSettings'
      if (result === 'written') changed = true
    }
    for (const script of [hookScriptPath(configDir), legacyScriptPath(configDir)]) {
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
