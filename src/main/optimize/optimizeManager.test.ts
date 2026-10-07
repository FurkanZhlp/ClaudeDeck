import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { Account, OptimizeState } from '../../shared/types'
import { createSessionTokens, MCP_TOKEN_ENV, type SessionTokens } from '../mcp/sessionTokens'
import { permissionRulePath } from '../platform/paths'
import {
  buildClaudeArgs,
  profileDenyRules,
  CANCEL_REPLY,
  OptimizeManager,
  optimizeWorkspace,
  parseStreamLine,
  type OptimizeManagerDeps
} from './optimizeManager'

// The run itself is tested with the macOS launch spec (login shell) on every host, so a Windows
// runner does not need claude.exe. The win32 launch spec is covered in platform/launch.test.ts.
vi.mock('../platform', async (importOriginal) =>
  (await import('../../test/platform')).withDarwinLaunch(await importOriginal())
)

/** An absolute config dir of the host OS (`/cfg`, or `D:\\cfg` on Windows). */
const CFG = resolve('/cfg')
/** `CFG` in permission rule syntax (`//cfg`, or `//d/cfg`). */
const CFG_RULE = permissionRulePath(CFG, process.platform)

const GUIDELINES = '<!-- claudedeck-guidelines v1 -->\n# Guidelines\n'
const MCP_URL = 'http://127.0.0.1:47821/mcp'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  /** Flushes the streams, then reports the exit. */
  async close(code: number): Promise<void> {
    await new Promise((r) => setImmediate(r))
    this.emit('close', code, null)
  }
}

interface Spawned {
  file: string
  args: string[]
  options: SpawnOptions
  child: FakeChild
}

let root: string
let account: Account
let tokens: SessionTokens
let spawned: Spawned[]
let emitted: OptimizeState[]
let killTree: Mock<(child: ChildProcess, signal: NodeJS.Signals) => void>
let deps: OptimizeManagerDeps
let manager: OptimizeManager
let clock: number

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const last = (): Spawned => spawned[spawned.length - 1]
const scopeOf = (): { kind: 'optimize'; runId: string; accountId: string } => {
  const token = (last().options.env as Record<string, string>)[MCP_TOKEN_ENV]
  const scope = tokens.lookup(token)
  if (scope?.kind !== 'optimize') throw new Error('no optimize scope')
  return scope
}

const proposal = { id: 'p1', title: 'Merge rules', rationale: 'Dupes', files: ['CLAUDE.md'] }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claudedeck-optimize-'))
  account = { id: 'a1', name: 'Work', color: '#000', configDir: join(root, 'profile') } as Account
  mkdirSync(join(account.configDir, 'agents'), { recursive: true })
  writeFileSync(join(account.configDir, 'CLAUDE.md'), '# Me\n')
  writeFileSync(join(account.configDir, 'agents', 'a.md'), 'agent a\n')
  writeFileSync(join(account.configDir, 'settings.json'), '{}\n')
  tokens = createSessionTokens()
  spawned = []
  emitted = []
  killTree = vi.fn<(child: ChildProcess, signal: NodeJS.Signals) => void>()
  clock = Date.UTC(2026, 9, 7, 12, 0, 0)
  deps = {
    account: (id) => {
      if (id !== account.id) throw new DomainError('NOT_FOUND')
      return account
    },
    claudeAvailable: () => Promise.resolve(true),
    baseEnv: () => Promise.resolve({ PATH: '/usr/bin', SHELL: '/bin/zsh' }),
    tokens,
    mcpUrl: () => MCP_URL,
    prompt: 'PROMPT',
    guidelinesText: GUIDELINES,
    emit: (state) => emitted.push(state),
    spawn: (file, args, options) => {
      const child = new FakeChild()
      spawned.push({ file, args, options, child })
      return child as unknown as ChildProcess
    },
    killTree,
    now: () => (clock += 1000),
    // Off on Windows by default; these tests cover the run itself on every OS.
    supported: true,
    os: 'darwin'
  }
  manager = new OptimizeManager(deps)
})

describe('optimize manager: start', () => {
  it('snapshots the profile and spawns claude headless through the login shell', async () => {
    const state = await manager.start('a1')
    expect(state.status).toBe('running')
    expect(state.backupDir).toMatch(
      /claudedeck[\\/]backups[\\/]optimize-2026-10-07T12-00-0\d\.\d{3}Z$/
    )
    const backup = state.backupDir as string
    expect(readFileSync(join(backup, 'CLAUDE.md'), 'utf8')).toBe(
      readFileSync(join(account.configDir, 'CLAUDE.md'), 'utf8')
    )
    expect(readFileSync(join(backup, 'agents', 'a.md'), 'utf8')).toBe('agent a\n')
    expect(existsSync(join(backup, 'skills'))).toBe(false)
    // Guidelines are installed (and imported) before the snapshot.
    expect(existsSync(join(account.configDir, 'claudedeck', 'guidelines.md'))).toBe(true)
    expect(readFileSync(join(backup, 'CLAUDE.md'), 'utf8')).toContain('@claudedeck/guidelines.md')

    const { file, args, options } = last()
    expect(file).toBe('/bin/zsh')
    expect(args[0]).toBe('-ilc')
    expect(args[1]).toMatch(/^exec env .*CLAUDE_CONFIG_DIR='.*' claude '-p' /)
    expect(options.cwd).toBe(optimizeWorkspace(account.configDir))
    expect(readdirSync(options.cwd as string)).toEqual([])
    expect(options.detached).toBe(true)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    const env = options.env as Record<string, string>
    expect(env.MCP_TOOL_TIMEOUT).toBe('86400000')
    expect(env.CLAUDE_CONFIG_DIR).toBe(account.configDir)
    expect(env[MCP_TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/)
    expect(scopeOf()).toEqual({ kind: 'optimize', runId: expect.any(String), accountId: 'a1' })
    expect(emitted.map((s) => s.status)).toEqual(['running'])
  })

  it('never puts the token on the command line', async () => {
    await manager.start('a1')
    const token = (last().options.env as Record<string, string>)[MCP_TOKEN_ENV]
    expect(last().args.join(' ')).not.toContain(token)
    const args = buildClaudeArgs({ prompt: 'P', configDir: CFG, mcpUrl: MCP_URL })
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(config).toEqual({
      mcpServers: {
        claudedeck: {
          type: 'http',
          url: MCP_URL,
          headers: { Authorization: 'Bearer ${CLAUDEDECK_MCP_TOKEN}' }
        }
      }
    })
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'mcp__claudedeck__optimize_status,mcp__claudedeck__optimize_findings,' +
        'mcp__claudedeck__optimize_ask,mcp__claudedeck__optimize_finish'
    )
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(
      'Bash,PowerShell,WebFetch,WebSearch,Task,NotebookEdit'
    )
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual([
      '--add-dir',
      CFG
    ])
  })

  it('refuses a second run of the same account and a missing claude', async () => {
    await manager.start('a1')
    await expect(manager.start('a1')).rejects.toMatchObject({ code: 'INVALID' })
    expect(spawned).toHaveLength(1)

    const other = new OptimizeManager({ ...deps, claudeAvailable: () => Promise.resolve(false) })
    await expect(other.start('a1')).rejects.toMatchObject({ code: 'CLAUDE_NOT_FOUND' })
    expect(other.get('a1').status).toBe('idle')
    await expect(manager.start('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('passes the prompt inline outside Windows', async () => {
    await manager.start('a1')
    const command = last().args.join(' ')
    expect(command).toMatch(/--append-system-prompt'? '?PROMPT/)
    expect(command).not.toContain('--append-system-prompt-file')
  })

  it('passes the prompt as a temp file on Windows and removes it after the run', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claudedeck-optimize-tmp-'))
    const win = new OptimizeManager({ ...deps, os: 'win32', tmpDir: tmp, newId: () => 'r1' })
    await win.start('a1')
    const dir = join(tmp, 'claudedeck-optimize-r1')
    const file = join(dir, 'system-prompt.md')
    expect(readFileSync(file, 'utf8')).toBe('PROMPT')
    const command = last().args.join(' ')
    expect(command).toContain('--append-system-prompt-file')
    expect(command).toContain(file)
    expect(command).not.toContain('PROMPT')
    // Outside the profile, so never inside the --add-dir scope.
    expect(file.startsWith(account.configDir)).toBe(false)
    await last().child.close(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('removes the prompt folder when the start fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claudedeck-optimize-tmp-'))
    const win = new OptimizeManager({
      ...deps,
      os: 'win32',
      tmpDir: tmp,
      newId: () => 'r2',
      spawn: () => {
        throw new Error('spawn failed')
      }
    })
    await expect(win.start('a1')).rejects.toThrow('spawn failed')
    expect(readdirSync(tmp)).toEqual([])
  })

  it('removes the prompt folder when cancelled before claude was spawned', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claudedeck-optimize-tmp-'))
    let release: (env: Record<string, string>) => void = () => undefined
    const win = new OptimizeManager({
      ...deps,
      os: 'win32',
      tmpDir: tmp,
      newId: () => 'r3',
      baseEnv: () => new Promise((resolve) => (release = resolve))
    })
    const started = win.start('a1')
    await tick()
    expect(win.cancel('a1').status).toBe('cancelled')
    release({ PATH: '/usr/bin' })
    await expect(started).resolves.toMatchObject({ status: 'cancelled' })
    expect(spawned).toHaveLength(0)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('refuses to start where optimize is not supported yet', async () => {
    const off = new OptimizeManager({ ...deps, supported: false })
    await expect(off.start('a1')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(off.isActive('a1')).toBe(false)
    expect(spawned).toHaveLength(0)
  })

  it('refuses to start without a running MCP server', async () => {
    const other = new OptimizeManager({ ...deps, mcpUrl: () => null })
    await expect(other.start('a1')).rejects.toMatchObject({ code: 'UNKNOWN' })
    expect(other.isActive('a1')).toBe(false)
  })
})

describe('optimize manager: questions', () => {
  it('blocks optimize_ask until the user answers and allows one pending question', async () => {
    await manager.start('a1')
    const scope = scopeOf()
    manager.port.status(scope, 'Reading CLAUDE.md')
    manager.port.findings(scope, { summary: 'ok', strengths: ['a'], issues: ['b'] })

    const asked = manager.port.ask(scope, { ...proposal, preview: '```diff\n+x\n```' })
    let state = manager.get('a1')
    expect(state.status).toBe('waiting')
    expect(state.pending).toMatchObject({ id: 'p1', title: 'Merge rules', files: ['CLAUDE.md'] })
    expect(() => manager.port.ask(scope, { ...proposal, id: 'p2' })).toThrow(/already waiting/)
    expect(() => manager.answer('a1', 'other', 'apply')).toThrow(DomainError)

    state = manager.answer('a1', 'p1', 'apply')
    expect(await asked).toBe('Decision: apply')
    expect(state.status).toBe('running')
    expect(state.pending).toBeNull()
    expect(state.events.map((e) => e.type)).toEqual(['status', 'findings', 'question', 'answer'])
  })

  it('formats skip and modify replies and requires a note for modify', async () => {
    await manager.start('a1')
    const scope = scopeOf()
    const skipped = manager.port.ask(scope, proposal)
    manager.answer('a1', 'p1', 'skip', 'ignored')
    expect(await skipped).toBe('Decision: skip')

    // A reused id gets a suffix so answers stay unambiguous.
    const modified = manager.port.ask(scope, proposal)
    expect(manager.get('a1').pending?.id).toBe('p1-2')
    expect(() => manager.answer('a1', 'p1-2', 'modify', '  ')).toThrow(DomainError)
    const state = manager.answer('a1', 'p1-2', 'modify', 'Keep the table')
    expect(await modified).toBe('Decision: modify. User note: Keep the table')
    expect(state.events.at(-1)).toMatchObject({
      type: 'answer',
      answer: { questionId: 'p1-2', decision: 'modify', note: 'Keep the table' }
    })
  })

  it('rejects calls from a stale or foreign run', async () => {
    await manager.start('a1')
    const scope = scopeOf()
    expect(() => manager.port.status({ ...scope, runId: 'old' }, 'x')).toThrow('Not allowed')
    expect(() => manager.port.status({ ...scope, accountId: 'a2' }, 'x')).toThrow('Not allowed')
  })
})

describe('optimize manager: lifecycle', () => {
  it('finishes through optimize_finish and revokes the token on exit', async () => {
    await manager.start('a1')
    const scope = scopeOf()
    const token = (last().options.env as Record<string, string>)[MCP_TOKEN_ENV]
    manager.port.finish(scope, { summary: 'Tidied', changes: ['Merged rules'] })
    expect(manager.get('a1').status).toBe('finished')
    expect(() => manager.port.status(scope, 'late')).toThrow('Not allowed')
    expect(tokens.lookup(token)).not.toBeNull()

    last().child.line({ type: 'result', subtype: 'success', is_error: false, result: 'Bye' })
    await last().child.close(0)
    const state = manager.get('a1')
    expect(state.status).toBe('finished')
    expect(state.events.filter((e) => e.type === 'finish')).toHaveLength(1)
    expect(state.finishedAt).not.toBeNull()
    expect(tokens.lookup(token)).toBeNull()
  })

  it('treats a clean exit without optimize_finish as finished with the last message', async () => {
    await manager.start('a1')
    last().child.line({ type: 'result', subtype: 'success', is_error: false, result: 'All good' })
    await last().child.close(0)
    const state = manager.get('a1')
    expect(state.status).toBe('finished')
    expect(state.events.at(-1)).toMatchObject({ type: 'finish', summary: 'All good', changes: [] })
  })

  it('fails on an error result or a non-zero exit and keeps a short stderr tail', async () => {
    await manager.start('a1')
    const asked = manager.port.ask(scopeOf(), proposal)
    last().child.stderr.write('boom: something broke\n')
    last().child.line({ type: 'result', subtype: 'error_during_execution', is_error: true })
    await last().child.close(1)
    expect(await asked).toBe(CANCEL_REPLY)
    const state = manager.get('a1')
    expect(state.status).toBe('failed')
    expect(state.pending).toBeNull()
    const error = state.events.at(-1)
    expect(error?.type).toBe('error')
    expect(error && 'message' in error && error.message).toMatch(
      /error_during_execution\nboom: something broke/
    )

    const second = new OptimizeManager(deps)
    await second.start('a1')
    await last().child.close(2)
    expect(second.get('a1').status).toBe('failed')
    expect(second.get('a1').events.at(-1)).toMatchObject({
      type: 'error',
      message: 'Claude exited with code 2'
    })
  })

  it('fails when the process cannot be spawned', async () => {
    await manager.start('a1')
    last().child.emit('error', new Error('spawn ENOENT'))
    expect(manager.get('a1').status).toBe('failed')
    expect(manager.get('a1').events.at(-1)).toMatchObject({
      type: 'error',
      message: 'Could not start Claude: spawn ENOENT'
    })
  })

  it('cancels: answers the waiting ask, kills the process group and stops tools', async () => {
    await manager.start('a1')
    const scope = scopeOf()
    const asked = manager.port.ask(scope, proposal)
    const state = manager.cancel('a1')
    expect(state.status).toBe('cancelled')
    expect(await asked).toBe(CANCEL_REPLY)
    expect(killTree).toHaveBeenCalledWith(last().child, 'SIGTERM')
    expect(() => manager.port.status(scope, 'x')).toThrow('Not allowed')
    expect(() => manager.cancel('a1')).toThrow(DomainError)
    await last().child.close(143)
    expect(manager.get('a1').status).toBe('cancelled')
    // A new run may start after a cancelled one.
    await expect(manager.start('a1')).resolves.toMatchObject({ status: 'running' })
  })

  it('disposeAll kills every active run', async () => {
    await manager.start('a1')
    manager.disposeAll()
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(manager.list().map((s) => s.status)).toEqual(['cancelled'])
  })

  it('maps tool_use lines to activity events and caps the event list', async () => {
    await manager.start('a1')
    const read = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking' },
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: join(account.configDir, 'agents', 'a.md') }
          },
          { type: 'tool_use', name: 'mcp__claudedeck__optimize_status', input: { message: 'x' } }
        ]
      }
    }
    // Delivered in two chunks to exercise line buffering.
    const text = `${JSON.stringify(read)}\n`
    last().child.stdout.write(text.slice(0, 20))
    last().child.stdout.write(text.slice(20))
    await tick()
    expect(manager.get('a1').events).toEqual([
      { type: 'activity', tool: 'Read', target: join('agents', 'a.md'), at: expect.any(Number) }
    ])

    for (let i = 0; i < 600; i++) last().child.line(read)
    await tick()
    expect(manager.get('a1').events).toHaveLength(500)
  })
})

describe('optimize manager: protected settings', () => {
  const settings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(account.configDir, 'settings.json'), 'utf8'))

  it('undoes hook and env edits after finish and lists them in the summary', async () => {
    writeFileSync(
      join(account.configDir, 'settings.json'),
      JSON.stringify({ model: 'opus', env: { A: '1' } })
    )
    await manager.start('a1')
    writeFileSync(
      join(account.configDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        env: { A: '1', ANTHROPIC_BASE_URL: 'https://x.example' },
        hooks: { Stop: [] }
      })
    )
    manager.port.finish(scopeOf(), { summary: 'Done', changes: ['Switched model'] })
    await last().child.close(0)
    expect(settings()).toEqual({ model: 'sonnet', env: { A: '1' } })
    const finish = manager.get('a1').events.find((e) => e.type === 'finish')
    expect(finish).toMatchObject({
      changes: ['Switched model', 'ClaudeDeck undid changes to protected settings: hooks, env']
    })
  })

  it('also guards a cancelled or failed run, reporting it as a status line', async () => {
    await manager.start('a1')
    writeFileSync(
      join(account.configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'evil' } })
    )
    manager.cancel('a1')
    await last().child.close(143)
    expect(settings()).toEqual({})
    expect(manager.get('a1').events.at(-1)).toMatchObject({
      type: 'status',
      message: 'ClaudeDeck undid changes to protected settings: statusLine'
    })
  })

  it('adds nothing when no protected key changed', async () => {
    await manager.start('a1')
    writeFileSync(join(account.configDir, 'settings.json'), JSON.stringify({ model: 'x' }))
    await last().child.close(1)
    expect(settings()).toEqual({ model: 'x' })
    expect(manager.get('a1').events.some((e) => e.type === 'status')).toBe(false)
  })
})

describe('optimize manager: revert', () => {
  it('restores the snapshot and backs up the current files first', async () => {
    const started = await manager.start('a1')
    const backup = started.backupDir as string
    const before = readFileSync(join(account.configDir, 'CLAUDE.md'), 'utf8')
    await expect(manager.revert('a1')).rejects.toMatchObject({ code: 'INVALID' })

    writeFileSync(join(account.configDir, 'CLAUDE.md'), '# Rewritten\n')
    writeFileSync(join(account.configDir, 'agents', 'b.md'), 'new agent\n')
    mkdirSync(join(account.configDir, 'claudedeck', 'instructions'), { recursive: true })
    writeFileSync(join(account.configDir, 'claudedeck', 'instructions', 'x.md'), 'moved\n')
    manager.port.finish(scopeOf(), { summary: 'Done', changes: ['Rewrote'] })
    // Still shutting down: refuse until the process exited.
    await expect(manager.revert('a1')).rejects.toMatchObject({ code: 'INVALID' })
    await last().child.close(0)

    const state = await manager.revert('a1')
    expect(state.reverted).toBe(true)
    expect(readFileSync(join(account.configDir, 'CLAUDE.md'), 'utf8')).toBe(before)
    expect(readdirSync(join(account.configDir, 'agents'))).toEqual(['a.md'])
    expect(existsSync(join(account.configDir, 'claudedeck', 'instructions'))).toBe(false)
    // The snapshot itself is kept.
    expect(readFileSync(join(backup, 'CLAUDE.md'), 'utf8')).toBe(before)

    const backups = join(account.configDir, 'claudedeck', 'backups')
    const reverted = readdirSync(backups).find((n) => n.startsWith('reverted-')) as string
    expect(reverted).toBeDefined()
    const dir = join(backups, reverted)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Rewritten\n')
    expect(readFileSync(join(dir, 'agents', 'b.md'), 'utf8')).toBe('new agent\n')
    expect(readFileSync(join(dir, 'claudedeck', 'instructions', 'x.md'), 'utf8')).toBe('moved\n')
    await expect(manager.revert('a1')).rejects.toMatchObject({ code: 'INVALID' })
  })
})

describe('parseStreamLine', () => {
  const cfg = '/Users/me/.claudedeck/a1'
  const use = (name: string, input: unknown): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

  it('maps file tools to profile-relative targets', () => {
    expect(parseStreamLine(use('Edit', { file_path: `${cfg}/CLAUDE.md` }), cfg)).toEqual([
      { kind: 'activity', tool: 'Edit', target: 'CLAUDE.md' }
    ])
    expect(parseStreamLine(use('Write', { file_path: '/etc/hosts' }), cfg)).toEqual([
      { kind: 'activity', tool: 'Write', target: 'hosts' }
    ])
    expect(parseStreamLine(use('Glob', { pattern: 'agents/*.md' }), cfg)).toEqual([
      { kind: 'activity', tool: 'Glob', target: 'agents/*.md' }
    ])
    expect(parseStreamLine(use('Grep', {}), cfg)).toEqual([{ kind: 'activity', tool: 'Grep' }])
  })

  it('ignores other tools, other messages and garbage', () => {
    expect(parseStreamLine(use('mcp__claudedeck__optimize_ask', {}), cfg)).toEqual([])
    expect(parseStreamLine(use('Bash', { command: 'ls' }), cfg)).toEqual([])
    expect(parseStreamLine('{"type":"system","subtype":"init"}', cfg)).toEqual([])
    expect(parseStreamLine('{"type":"user","message":{"content":"x"}}', cfg)).toEqual([])
    expect(parseStreamLine('not json', cfg)).toEqual([])
    expect(parseStreamLine('[1,2]', cfg)).toEqual([])
  })

  it('reads results', () => {
    expect(
      parseStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"ok"}', cfg)
    ).toEqual([{ kind: 'result', isError: false, text: 'ok' }])
    expect(parseStreamLine('{"type":"result","subtype":"error_max_turns"}', cfg)).toEqual([
      { kind: 'result', isError: true, text: 'error_max_turns' }
    ])
  })
})

describe('profileDenyRules', () => {
  it('blocks credentials and transcripts and keeps app files read-only', () => {
    const rules = profileDenyRules(
      '/Users/me/Library/Application Support/ClaudeDeck/accounts/a',
      (abs) => permissionRulePath(abs, 'darwin')
    )
    const root = '//Users/me/Library/Application Support/ClaudeDeck/accounts/a'
    expect(rules).toContain(`Read(${root}/.claude.json)`)
    expect(rules).toContain(`Edit(${root}/projects/**)`)
    expect(rules).toContain(`Edit(${root}/claudedeck/guidelines.md)`)
    expect(rules).not.toContain(`Read(${root}/claudedeck/guidelines.md)`)
  })
  it('keeps every app-managed file that runs or feeds code later read-only', () => {
    const rules = profileDenyRules('/cfg', (abs) => permissionRulePath(abs, 'darwin'))
    for (const rel of [
      'claudedeck/statusline.sh',
      'claudedeck/statusline.ps1',
      'claudedeck/statusline-original.json',
      'claudedeck/usage-raw.json',
      'claudedeck/usage-raw.json.*',
      'claudedeck/guidelines.md',
      'claudedeck/backups/**',
      'plugins/**'
    ]) {
      expect(rules).toContain(`Edit(//cfg/${rel})`)
    }
    // The run edits instructions and works in the workspace; a deny rule cannot carve out an
    // exception, so nothing may cover them.
    expect(rules.some((rule) => /claudedeck\/(\*|instructions|workspace)/.test(rule))).toBe(false)
  })
  it('passes the rules through --settings', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      configDir: CFG,
      mcpUrl: 'http://127.0.0.1:1/mcp'
    })
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings.permissions.deny).toContain(`Read(${CFG_RULE}/.claude.json)`)
  })
})

describe('profileDenyRules on Windows', () => {
  it('uses the //c/... rule form for the credentials file', () => {
    const rules = profileDenyRules(
      'C:\\Users\\A B\\AppData\\Roaming\\ClaudeDeck\\accounts\\a',
      (abs) => permissionRulePath(abs, 'win32')
    )
    const root = '//c/Users/A B/AppData/Roaming/ClaudeDeck/accounts/a'
    expect(rules).toContain(`Read(${root}/.credentials.json)`)
    expect(rules).toContain(`Edit(${root}/.credentials.json)`)
    expect(rules.every((rule) => !rule.includes('\\'))).toBe(true)
  })
})
