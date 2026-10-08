import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { GuardSettings, Project } from '../../shared/types'
import type { SessionScope } from '../mcp/sessionTokens'
import { defaultGuardSettings } from '../state/guardSettings'
import {
  BRANCH_CACHE_MS,
  cachedGitBranch,
  readGitBranch,
  readSmallFile,
  type BranchFs
} from './gitBranch'
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
    projects: () => [project],
    account: (id) =>
      id === 'a1'
        ? { id, name: 'A', color: 'blue', configDir: '/Users/dev/cd/accounts/a1' }
        : undefined,
    appDataDir: '/Users/dev/cd',
    home: '/Users/dev',
    os: 'darwin',
    env: {},
    gitBranch,
    realpath: (path) => {
      const links: Record<string, string> = { '/Users/dev/app/notes': '/Users/dev/.ssh' }
      const existing = ['/', '/Users', '/Users/dev', '/Users/dev/app', '/Users/dev/app/src']
      if (links[path]) return links[path]
      if (existing.includes(path)) return path
      throw new Error('ENOENT')
    },
    log
  })
  return { service, log, events, gitBranch }
}

describe('guard service', () => {
  it('replies with the decision and logs it with the tab', async () => {
    const { service, log, events } = setup()
    const reply = await service.check(scope, {
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

  it('protects the tab account and ClaudeDeck data', async () => {
    const { service } = setup()
    const write = (path: string): Promise<string | null> =>
      service.check(scope, { tool_name: 'Write', tool_input: { file_path: path } })
    expect(await write('/Users/dev/cd/accounts/a1/settings.json')).toContain('deny')
    expect(await write('/Users/dev/cd/accounts/a2/settings.json')).toContain('deny')
    expect(await write('/Users/dev/cd/accounts/a1/projects/k/memory/MEMORY.md')).toBeNull()
    expect(await write('/Users/dev/app/src/a.ts')).toBeNull()
  })

  it('checks where a written path leads through symlinks too', async () => {
    const { service } = setup()
    const reply = await service.check(scope, {
      tool_name: 'Write',
      tool_input: { file_path: '/Users/dev/app/notes/authorized_keys' }
    })
    expect(JSON.parse(reply as string).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(
      await service.check(scope, {
        tool_name: 'Edit',
        tool_input: { file_path: '/Users/dev/app/src/new/a.ts' }
      })
    ).toBeNull()
  })

  it('checks a guard-only call in the project that holds its folder', async () => {
    const { service, log } = setup()
    const reply = await service.check(
      { kind: 'account', accountId: 'a1' },
      { tool_name: 'Bash', tool_input: { command: 'git push -f' }, cwd: '/Users/dev/app/src' }
    )
    // The project sets git to deny; the global default is ask.
    expect(JSON.parse(reply as string).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(log.list()[0]).toMatchObject({ sessionId: '', projectId: 'p1', accountId: 'a1' })
  })

  it('lets allowed and unknown calls through without logging', async () => {
    const { service, log } = setup()
    expect(
      await service.check(scope, { tool_name: 'Bash', tool_input: { command: 'ls' } })
    ).toBeNull()
    expect(
      await service.check(scope, { tool_name: 'Read', tool_input: { file_path: '/etc/x' } })
    ).toBeNull()
    expect(await service.check(scope, null)).toBeNull()
    expect(await service.check(scope, { tool_name: 7 })).toBeNull()
    expect(log.list()).toEqual([])
  })

  it('does nothing while the guard is off', async () => {
    const { service } = setup({ ...defaultGuardSettings(), enabled: false })
    expect(
      await service.check(scope, { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } })
    ).toBeNull()
  })

  it('denies when the guard itself fails', async () => {
    const { service } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const payload = {
      tool_name: 'Bash',
      get tool_input(): never {
        throw new Error('bad')
      }
    }
    expect(await service.check(scope, payload)).toBe(GUARD_ERROR_REPLY)
    expect(JSON.stringify(error.mock.calls)).not.toContain('tool_input')
    error.mockRestore()
  })

  it('reads the branch only for git commands', async () => {
    const { service, gitBranch } = setup()
    await service.check(scope, {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/Users/dev/app'
    })
    expect(gitBranch).not.toHaveBeenCalled()
    const reply = await service.check(scope, {
      tool_name: 'Bash',
      tool_input: { command: 'git rebase origin/main' },
      cwd: '/Users/dev/app'
    })
    expect(gitBranch).toHaveBeenCalledWith('/Users/dev/app')
    expect(reply).toContain('rebasing a shared branch')
  })

  it('evaluates "try a command" with the project folder and overrides', async () => {
    const { service, log } = setup()
    expect((await service.evaluate({ input: 'git push -f' })).action).toBe('ask')
    expect((await service.evaluate({ input: 'git push -f', projectId: 'p1' })).action).toBe('deny')
    expect((await service.evaluate({ tool: 'Write', input: '/Users/dev/.zshrc' })).ruleId).toBe(
      'sensitive.shellRc'
    )
    expect(
      (await service.evaluate({ tool: 'NotebookEdit', input: '/Users/dev/.ssh/x.ipynb' })).ruleId
    ).toBe('sensitive.ssh')
    expect(log.list()).toEqual([])
    for (const bad of [
      null,
      { input: 3 },
      { tool: 'Read', input: 'x' },
      { input: 'x'.repeat(70_000) }
    ]) {
      await expect(service.evaluate(bad as never)).rejects.toThrow(DomainError)
    }
    await expect(service.evaluate({ input: 'ls', projectId: 'nope' })).rejects.toThrow(DomainError)
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

describe('git branch reads', () => {
  it('reads at most 4 KB of a regular file and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-branch-'))
    const big = join(dir, 'big')
    writeFileSync(big, 'x'.repeat(10_000))
    expect(readSmallFile(big)).toHaveLength(4096)
    expect(readSmallFile(dir)).toBeNull()
    expect(readSmallFile(join(dir, 'missing'))).toBeNull()
  })

  it('caches the branch per folder for a short time', () => {
    let t = 0
    const read = vi.fn((cwd: string) => (cwd === '/a' ? 'main' : null))
    const branch = cachedGitBranch(read, () => t)
    expect(branch('/a')).toBe('main')
    expect(branch('/a')).toBe('main')
    expect(branch('/b')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
    t += BRANCH_CACHE_MS
    branch('/a')
    expect(read).toHaveBeenCalledTimes(3)
  })
})
