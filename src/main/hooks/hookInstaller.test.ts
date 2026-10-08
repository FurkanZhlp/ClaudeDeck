import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectMode } from '../../test/platform'
import {
  hookScriptPath,
  installHooks,
  removeHooks,
  type HookFeatures,
  type HookHost
} from './hookInstaller'
import { GUARD_MATCHER } from './hookScript'

const both: HookFeatures = { guard: true, queue: true, maxWaitMinutes: 60 }
const queueOnly: HookFeatures = { guard: false, queue: true, maxWaitMinutes: 60 }
const guardOnly: HookFeatures = { guard: true, queue: false, maxWaitMinutes: 60 }
const installTestQueueHooks = (
  dir: string,
  maxWait: number,
  host: HookHost
): ReturnType<typeof installHooks> =>
  installHooks(dir, { ...queueOnly, maxWaitMinutes: maxWait }, host)
const removeTestQueueHooks = removeHooks

let dir: string
const mac: HookHost = { os: 'darwin', env: {} }
const settingsFile = (): string => join(dir, 'settings.json')
const read = (): Record<string, unknown> => JSON.parse(readFileSync(settingsFile(), 'utf8'))
const write = (value: unknown): void => writeFileSync(settingsFile(), JSON.stringify(value))

const userHook = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/local/bin/my-guard' }]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-tq-hooks-'))
})

describe('installHooks (test queue only)', () => {
  it('adds pre and post groups and writes the script', () => {
    const result = installTestQueueHooks(dir, 60, mac)
    expect(result).toEqual({ installed: true, problem: null, changed: true })
    const command = (event: string): string => `/bin/sh '${hookScriptPath(dir)}' ${event}`
    expect(read().hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: command('pre'), timeout: 3660 }]
        }
      ],
      PostToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: command('post'), timeout: 10, async: true }]
        }
      ],
      PostToolUseFailure: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: command('post'), timeout: 10, async: true }]
        }
      ]
    })
    expect(readFileSync(hookScriptPath(dir), 'utf8')).toContain('curl -q -s')
    expectMode(hookScriptPath(dir), 0o755)
    expectMode(settingsFile(), 0o600)
  })

  it('is idempotent and keeps the user hooks and other settings', () => {
    write({ model: 'opus', hooks: { PreToolUse: [userHook], Stop: [userHook] } })
    installTestQueueHooks(dir, 60, mac)
    const first = readFileSync(settingsFile(), 'utf8')
    expect(installTestQueueHooks(dir, 60, mac).changed).toBe(false)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(first)
    const settings = read() as { model: string; hooks: Record<string, unknown[]> }
    expect(settings.model).toBe('opus')
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(settings.hooks.PreToolUse[0]).toEqual(userHook)
    expect(settings.hooks.Stop).toEqual([userHook])
  })

  it('updates the timeout when the max wait changes, without duplicating', () => {
    installTestQueueHooks(dir, 60, mac)
    installTestQueueHooks(dir, 5, mac)
    const hooks = read().hooks as Record<string, { hooks: { timeout: number }[] }[]>
    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(360)
    expect(readFileSync(hookScriptPath(dir), 'utf8')).toContain('polls=36')
  })

  it('takes our hook out of a shared group but leaves the rest of it', () => {
    write({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '/bin/sh /old/claudedeck/test-queue.sh pre' },
              { type: 'command', command: 'mine' }
            ]
          }
        ]
      }
    })
    removeTestQueueHooks(dir)
    expect(read().hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }]
    })
  })

  it('never touches invalid JSON or a hooks value of the wrong shape', () => {
    writeFileSync(settingsFile(), '{ broken')
    expect(installTestQueueHooks(dir, 60, mac).problem).toBe('invalidSettings')
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ broken')
    expect(existsSync(hookScriptPath(dir))).toBe(false)

    write({ hooks: { PreToolUse: 'nope' } })
    expect(installTestQueueHooks(dir, 60, mac).problem).toBe('invalidSettings')
    expect(read()).toEqual({ hooks: { PreToolUse: 'nope' } })
  })

  it('skips Windows without Git Bash', () => {
    const win: HookHost = { os: 'win32', env: {}, exists: () => false }
    expect(installTestQueueHooks(dir, 60, win)).toMatchObject({
      installed: false,
      problem: 'noGitBash'
    })
    expect(existsSync(settingsFile())).toBe(false)
  })

  it('installs on Windows with Git Bash using a slash path', () => {
    const win: HookHost = {
      os: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' },
      exists: (p: string) => p === 'D:\\Git\\bin\\bash.exe'
    }
    expect(installTestQueueHooks(dir, 60, win).installed).toBe(true)
    const hooks = read().hooks as Record<string, { hooks: { command: string }[] }[]>
    expect(hooks.PreToolUse[0].hooks[0].command).not.toContain('\\')
  })
})

describe('removeTestQueueHooks', () => {
  it('removes only our groups, drops emptied keys and the script', () => {
    write({ theme: 'dark', hooks: { PreToolUse: [userHook] } })
    installTestQueueHooks(dir, 60, mac)
    expect(removeTestQueueHooks(dir).changed).toBe(true)
    expect(read()).toEqual({ theme: 'dark', hooks: { PreToolUse: [userHook] } })
    expect(existsSync(hookScriptPath(dir))).toBe(false)
    expect(removeTestQueueHooks(dir).changed).toBe(false)
  })

  it('removes the hooks key it created', () => {
    write({ theme: 'dark' })
    installTestQueueHooks(dir, 60, mac)
    removeTestQueueHooks(dir)
    expect(read()).toEqual({ theme: 'dark' })
  })

  it('does nothing without settings.json', () => {
    expect(removeTestQueueHooks(dir)).toEqual({ installed: false, problem: null, changed: false })
    expect(existsSync(settingsFile())).toBe(false)
  })
})

describe('installHooks (command guard)', () => {
  const pre = (): { matcher: string; hooks: { timeout: number }[] }[] =>
    (read().hooks as Record<string, never>).PreToolUse

  it('installs only a pre group for every guarded tool while the queue is off', () => {
    expect(installHooks(dir, guardOnly, mac)).toMatchObject({ installed: true, changed: true })
    const hooks = read().hooks as Record<string, unknown[]>
    expect(Object.keys(hooks)).toEqual(['PreToolUse'])
    expect(pre()).toEqual([
      {
        matcher: GUARD_MATCHER,
        hooks: [{ type: 'command', command: `/bin/sh '${hookScriptPath(dir)}' pre`, timeout: 30 }]
      }
    ])
    expect(GUARD_MATCHER).toBe('Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit')
    expect(readFileSync(hookScriptPath(dir), 'utf8')).toContain('guard=1')
  })

  it('uses the queue timeout and adds post groups when both are on', () => {
    installHooks(dir, both, mac)
    expect(pre()[0].matcher).toBe(GUARD_MATCHER)
    expect(pre()[0].hooks[0].timeout).toBe(3660)
    const hooks = read().hooks as Record<string, unknown[]>
    expect(hooks.PostToolUse).toHaveLength(1)
    // Turning the queue off drops the post groups and keeps the guard.
    installHooks(dir, guardOnly, mac)
    expect(Object.keys(read().hooks as object)).toEqual(['PreToolUse'])
    expect(installHooks(dir, guardOnly, mac).changed).toBe(false)
  })

  it('removes everything when neither is on', () => {
    write({ hooks: { PreToolUse: [userHook] } })
    installHooks(dir, both, mac)
    expect(installHooks(dir, { ...both, guard: false, queue: false }, mac)).toMatchObject({
      installed: false,
      changed: true
    })
    expect(read()).toEqual({ hooks: { PreToolUse: [userHook] } })
    expect(existsSync(hookScriptPath(dir))).toBe(false)
  })

  it('migrates the old test-queue.sh groups and script, once', () => {
    const legacy = join(dir, 'claudedeck', 'test-queue.sh')
    mkdirSync(join(dir, 'claudedeck'), { recursive: true })
    writeFileSync(legacy, '#!/bin/sh\nexit 0\n')
    const old = (event: string): unknown => ({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `/bin/sh '${legacy}' ${event}`, timeout: 3660 }]
    })
    write({
      model: 'opus',
      hooks: {
        PreToolUse: [userHook, old('pre')],
        PostToolUse: [old('post')],
        PostToolUseFailure: [old('post')]
      }
    })
    expect(installHooks(dir, guardOnly, mac).changed).toBe(true)
    const settings = read() as { model: string; hooks: Record<string, unknown[]> }
    expect(settings.model).toBe('opus')
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse'])
    expect(settings.hooks.PreToolUse).toHaveLength(2)
    expect(settings.hooks.PreToolUse[0]).toEqual(userHook)
    expect(JSON.stringify(settings.hooks)).not.toContain('test-queue.sh')
    expect(existsSync(legacy)).toBe(false)
    const first = readFileSync(settingsFile(), 'utf8')
    expect(installHooks(dir, guardOnly, mac).changed).toBe(false)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(first)
  })

  it('removes the old script with the hooks', () => {
    const legacy = join(dir, 'claudedeck', 'test-queue.sh')
    mkdirSync(join(dir, 'claudedeck'), { recursive: true })
    writeFileSync(legacy, '#!/bin/sh\n')
    expect(removeHooks(dir).changed).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })
})
