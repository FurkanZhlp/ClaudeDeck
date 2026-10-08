import * as nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { GuardSettings, Project } from '../../shared/types'
import type { SessionScope } from '../mcp/sessionTokens'
import { defaultGuardSettings } from '../state/guardSettings'
import { readGitBranch, type BranchFs } from './gitBranch'
import { createGuardLog, type GuardLog } from './guardLog'
import { createGuardService, GUARD_ERROR_REPLY, type GuardService } from './guardService'

// Payloads carry command STRINGS for the pure evaluator only; nothing is executed.

const scope: SessionScope = { kind: 'session', sessionId: 's1', projectId: 'p1', accountId: 'a1' }
const project: Project = {
  id: 'p1',
  name: 'App',
  path: '/Users/dev/app',
  accountId: 'a1',
  guard: { categories: { git: 'deny' }, ruleOverrides: {}, customRules: [] }
}

function setup(settings: GuardSettings = defaultGuardSettings()): {
  service: GuardService
  log: GuardLog
  events: unknown[]
  gitBranch: ReturnType<typeof vi.fn>
} {
  const events: unknown[] = []
  const log = createGuardLog({ onEntry: (e) => events.push(e), newId: () => 'id', now: () => 1 })
  const gitBranch = vi.fn(() => 'main')
  const service = createGuardService({
    settings: () => settings,
    project: (id) => (id === 'p1' ? project : undefined),
    account: (id) =>
      id === 'a1'
        ? { id, name: 'A', color: 'blue', configDir: '/Users/dev/cd/accounts/a1' }
        : undefined,
    appDataDir: '/Users/dev/cd',
    home: '/Users/dev',
    os: 'darwin',
    env: {},
    gitBranch,
    log
  })
  return { service, log, events, gitBranch }
}

describe('guard service', () => {
  it('replies with the decision and logs it with the tab', () => {
    const { service, log, events } = setup()
    const reply = service.check(scope, {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main --force' },
      cwd: '/Users/dev/app',
      agent_id: 'agent-1'
    })
    const parsed = JSON.parse(reply as string)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('force push')
    expect(parsed.systemMessage).toContain('git push origin main --force')
    expect(log.list()).toEqual([
      {
        id: 'id',
        at: 1,
        sessionId: 's1',
        projectId: 'p1',
        accountId: 'a1',
        agentId: 'agent-1',
        tool: 'Bash',
        category: 'git',
        ruleId: 'git.forcePush',
        action: 'deny',
        excerpt: 'git push origin main --force'
      }
    ])
    expect(events).toHaveLength(1)
  })

  it('protects the tab account and ClaudeDeck data', () => {
    const { service } = setup()
    const write = (path: string): string | null =>
      service.check(scope, { tool_name: 'Write', tool_input: { file_path: path } })
    expect(write('/Users/dev/cd/accounts/a1/settings.json')).toContain('deny')
    expect(write('/Users/dev/cd/accounts/a2/settings.json')).toContain('deny')
    expect(write('/Users/dev/cd/accounts/a1/projects/k/memory/MEMORY.md')).toBeNull()
    expect(write('/Users/dev/app/src/a.ts')).toBeNull()
  })

  it('lets allowed and unknown calls through without logging', () => {
    const { service, log } = setup()
    expect(service.check(scope, { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull()
    expect(
      service.check(scope, { tool_name: 'Read', tool_input: { file_path: '/etc/x' } })
    ).toBeNull()
    expect(service.check(scope, null)).toBeNull()
    expect(service.check(scope, { tool_name: 7 })).toBeNull()
    expect(log.list()).toEqual([])
  })

  it('does nothing while the guard is off', () => {
    const { service } = setup({ ...defaultGuardSettings(), enabled: false })
    expect(
      service.check(scope, { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } })
    ).toBeNull()
  })

  it('denies when the guard itself fails', () => {
    const { service } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const payload = {
      tool_name: 'Bash',
      get tool_input(): never {
        throw new Error('bad')
      }
    }
    expect(service.check(scope, payload)).toBe(GUARD_ERROR_REPLY)
    expect(JSON.stringify(error.mock.calls)).not.toContain('tool_input')
    error.mockRestore()
  })

  it('reads the branch only for git commands', () => {
    const { service, gitBranch } = setup()
    service.check(scope, {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/Users/dev/app'
    })
    expect(gitBranch).not.toHaveBeenCalled()
    const reply = service.check(scope, {
      tool_name: 'Bash',
      tool_input: { command: 'git rebase origin/main' },
      cwd: '/Users/dev/app'
    })
    expect(gitBranch).toHaveBeenCalledWith('/Users/dev/app')
    expect(reply).toContain('rebasing a shared branch')
  })

  it('evaluates "try a command" with the project folder and overrides', () => {
    const { service, log } = setup()
    expect(service.evaluate({ input: 'git push -f' }).action).toBe('ask')
    expect(service.evaluate({ input: 'git push -f', projectId: 'p1' }).action).toBe('deny')
    expect(service.evaluate({ tool: 'Write', input: '/Users/dev/.zshrc' }).ruleId).toBe(
      'sensitive.shellRc'
    )
    expect(
      service.evaluate({ tool: 'NotebookEdit', input: '/Users/dev/.ssh/x.ipynb' }).ruleId
    ).toBe('sensitive.ssh')
    expect(log.list()).toEqual([])
    for (const bad of [
      null,
      { input: 3 },
      { tool: 'Read', input: 'x' },
      { input: 'x'.repeat(70_000) }
    ]) {
      expect(() => service.evaluate(bad as never)).toThrow(DomainError)
    }
    expect(() => service.evaluate({ input: 'ls', projectId: 'nope' })).toThrow(DomainError)
  })
})

describe('guard log', () => {
  it('keeps the newest 200 entries, newest first', () => {
    let n = 0
    const log = createGuardLog({ newId: () => String(++n) })
    const entry = {
      sessionId: 's',
      projectId: 'p',
      accountId: 'a',
      tool: 'Bash' as const,
      category: 'git' as const,
      ruleId: 'git.clean',
      action: 'ask' as const,
      excerpt: 'git clean -f'
    }
    for (let i = 0; i < 205; i++) log.add(entry)
    expect(log.list()).toHaveLength(200)
    expect(log.list()[0].id).toBe('205')
    log.clear()
    expect(log.list()).toEqual([])
  })
})

describe('readGitBranch', () => {
  const p = nodePath.posix
  const fake = (files: Record<string, string>, dirs: string[]): BranchFs => ({
    read: (path) => files[path] ?? null,
    kind: (path) => (dirs.includes(path) ? 'dir' : path in files ? 'file' : null)
  })

  it('reads HEAD from the repository above the folder', () => {
    const fs = fake({ '/r/.git/HEAD': 'ref: refs/heads/feature/x\n' }, ['/r/.git'])
    expect(readGitBranch('/r/src/deep', fs, p)).toBe('feature/x')
  })

  it('follows a worktree .git file', () => {
    const fs = fake(
      {
        '/w/.git': 'gitdir: /r/.git/worktrees/w\n',
        '/r/.git/worktrees/w/HEAD': 'ref: refs/heads/main\n'
      },
      []
    )
    expect(readGitBranch('/w', fs, p)).toBe('main')
  })

  it('is null outside a repository or on a detached HEAD', () => {
    expect(readGitBranch('/x/y', fake({}, []), p)).toBeNull()
    expect(readGitBranch('/r', fake({ '/r/.git/HEAD': 'abc123\n' }, ['/r/.git']), p)).toBeNull()
  })
})
