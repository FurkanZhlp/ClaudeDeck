import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TestQueueHookProblem } from '../../shared/types'
import type { OsName } from '../platform/types'
import {
  isObject,
  type Json,
  readSettings,
  settingsPath,
  writeIfChanged,
  writeSettings
} from '../profile/settingsFile'
import { findGitBash } from '../usage/statuslineScript'
import {
  HOOK_SCRIPT_FILE,
  hookCommand,
  hookScript,
  OURS,
  POST_HOOK_TIMEOUT_SECONDS,
  preHookTimeout,
  type HookEvent
} from './hookScript'

const SCRIPT_MODE = 0o755
const BASH_MATCHER = 'Bash'

/** settings.json hook events ClaudeDeck adds a group to, with the script event they call. */
export const HOOK_EVENTS: readonly (readonly [string, HookEvent])[] = [
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['PostToolUseFailure', 'post']
]

export const hookScriptPath = (configDir: string): string =>
  join(configDir, 'claudedeck', HOOK_SCRIPT_FILE)

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

function ourGroup(scriptPath: string, event: HookEvent, os: OsName, maxWait: number): Json {
  const command = hookCommand(scriptPath, event, os)
  const hook: Json =
    event === 'pre'
      ? { type: 'command', command, timeout: preHookTimeout(maxWait) }
      : { type: 'command', command, timeout: POST_HOOK_TIMEOUT_SECONDS, async: true }
  return { matcher: BASH_MATCHER, hooks: [hook] }
}

/**
 * New `hooks` value with our groups replaced (`install`) or removed; null when the existing
 * value has a shape we must not touch (not an object, or an event that is not an array).
 */
function nextHooks(current: unknown, add: ((event: HookEvent) => Json) | null): Json | null {
  if (current !== undefined && !isObject(current)) return null
  const hooks: Json = { ...(current ?? {}) }
  for (const [name, event] of HOOK_EVENTS) {
    const existing = hooks[name]
    if (existing !== undefined && !Array.isArray(existing)) return null
    const kept = withoutOurs(existing ?? [])
    if (add) hooks[name] = [...kept, add(event)]
    else if (kept.length > 0) hooks[name] = kept
    else if (existing !== undefined) delete hooks[name]
  }
  return hooks
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Adds ClaudeDeck's test queue groups to the account's settings.json and writes the script.
 * Idempotent; the user's own hooks are kept as they are. Windows without Git Bash gets no hook
 * (Claude Code has no Bash tool there either). Invalid settings.json is never touched.
 */
export function installTestQueueHooks(
  configDir: string,
  maxWaitMinutes: number,
  host: HookHost = currentHookHost()
): HookInstallResult {
  if (host.os === 'win32' && !findGitBash(host.env, host.exists)) {
    const removed = removeTestQueueHooks(configDir)
    return { installed: false, problem: 'noGitBash', changed: removed.changed }
  }
  const file = settingsPath(configDir)
  const settings = readSettings(file)
  if (!settings) return { installed: false, problem: 'invalidSettings', changed: false }
  const scriptPath = hookScriptPath(configDir)
  const hooks = nextHooks(settings.hooks, (event) =>
    ourGroup(scriptPath, event, host.os, maxWaitMinutes)
  )
  if (!hooks) return { installed: false, problem: 'invalidSettings', changed: false }

  try {
    mkdirSync(join(configDir, 'claudedeck'), { recursive: true })
    // The script first: a hook pointing at a missing file would fail every Bash call's hook.
    let changed = writeIfChanged(scriptPath, hookScript(maxWaitMinutes), SCRIPT_MODE)
    if (!sameJson(settings.hooks, hooks)) {
      writeSettings(file, { ...settings, hooks })
      changed = true
    }
    return { installed: true, problem: null, changed }
  } catch (error) {
    console.warn('[test-queue] could not install hooks', error)
    return { installed: false, problem: 'writeFailed', changed: false }
  }
}

/** Removes ClaudeDeck's groups (only those) and the script. */
export function removeTestQueueHooks(configDir: string): HookInstallResult {
  const file = settingsPath(configDir)
  const settings = existsSync(file) ? readSettings(file) : null
  let changed = false
  let problem: TestQueueHookProblem | null = null
  try {
    if (settings && settings.hooks !== undefined) {
      const hooks = nextHooks(settings.hooks, null)
      if (!hooks) problem = 'invalidSettings'
      else if (!sameJson(settings.hooks, hooks)) {
        const next = { ...settings }
        if (Object.keys(hooks).length > 0) next.hooks = hooks
        else delete next.hooks
        writeSettings(file, next)
        changed = true
      }
    } else if (existsSync(file) && !settings) {
      problem = 'invalidSettings'
    }
    const script = hookScriptPath(configDir)
    if (existsSync(script)) {
      rmSync(script, { force: true })
      changed = true
    }
  } catch (error) {
    console.warn('[test-queue] could not remove hooks', error)
    problem = 'writeFailed'
  }
  return { installed: false, problem, changed }
}
