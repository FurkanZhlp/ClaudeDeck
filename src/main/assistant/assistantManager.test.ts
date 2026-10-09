import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AssistantDoneEvent,
  AssistantErrorEvent,
  AssistantProposal,
  AssistantQuestion,
  AssistantStatusEvent
} from '../../shared/assistant'
import type { Account } from '../../shared/types'
import { testEvaluators, testRepository } from '../../test/assistant'
import { createAssistantTools } from '../mcp/assistantTools'
import { createOptimizeTools } from '../mcp/optimizeTools'
import { startMcpServer, type RunningMcpServer } from '../mcp/server'
import { createSessionTokens, MCP_TOKEN_ENV, type SessionTokens } from '../mcp/sessionTokens'
import { createTools } from '../mcp/tools'
import { encodeProjectKey } from '../notes/memoryPath'
import type { Repository } from '../state/repository'
import {
  AssistantManager,
  buildAssistantArgs,
  DISALLOWED_TOOLS,
  initialMessage,
  parseAssistantLine
} from './assistantManager'
import { SettingsWriter } from './settingsWriter'

// Runs are tested with the macOS launch spec on every host (no claude.exe needed on Windows).
vi.mock('../platform', async (importOriginal) =>
  (await import('../../test/platform')).withDarwinLaunch(await importOriginal())
)

/** A scripted `claude`: the test writes its stream-json and drives the MCP tools itself. */
class FakeClaude extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()

  line(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  async exit(code: number | null): Promise<void> {
    await new Promise((r) => setImmediate(r))
    this.emit('close', code, null)
  }
}

interface Spawned {
  args: string[]
  options: SpawnOptions
  child: FakeClaude
}

const toolUse = (name: string): unknown => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: `mcp__claudedeck__${name}`, input: {} }] }
})
const result = (text: string, isError = false): unknown => ({
  type: 'result',
  subtype: isError ? 'error_during_execution' : 'success',
  is_error: isError,
  result: text
})

let repo: Repository
let dir: string
let projectId: string
let account: Account
let tokens: SessionTokens
let server: RunningMcpServer
let manager: AssistantManager
let spawned: Spawned[]
let killTree: Mock<(child: ChildProcess, signal: NodeJS.Signals) => void>
let events: {
  status: AssistantStatusEvent[]
  proposal: AssistantProposal[]
  question: AssistantQuestion[]
  done: AssistantDoneEvent[]
  error: AssistantErrorEvent[]
}
const clients: Client[] = []

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

async function until<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick()
  }
}

const last = (): Spawned => spawned[spawned.length - 1]
const tokenOf = (s: Spawned = last()): string =>
  (s.options.env as Record<string, string>)[MCP_TOKEN_ENV]

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'fake-claude', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  clients.push(client)
  return client
}

type CallResult = Awaited<ReturnType<Client['callTool']>>
const textOf = (r: CallResult): string => (r.content as { text: string }[])[0].text

function setup(timeouts?: ConstructorParameters<typeof AssistantManager>[0]['timeouts']): void {
  const evaluators = testEvaluators()
  manager = new AssistantManager({
    account: (id) => repo.account(id),
    claudeAvailable: () => Promise.resolve(true),
    baseEnv: () => Promise.resolve({ PATH: '/usr/bin', SHELL: '/bin/zsh' }),
    tokens,
    mcpUrl: () => server.url,
    prompt: 'SETTINGS ASSISTANT PROMPT',
    state: () => repo.get(),
    language: () => 'tr',
    evaluators,
    writer: new SettingsWriter({
      repo,
      catalog: evaluators.catalog,
      effects: {
        guardEnabledChanged: () => undefined,
        testQueueChanged: () => undefined,
        usageChanged: () => undefined,
        languageChanged: () => undefined,
        launchAtLoginChanged: () => undefined,
        stateChanged: () => undefined
      }
    }),
    events: {
      status: (e) => events.status.push(e),
      proposal: (p) => events.proposal.push(p),
      question: (q) => events.question.push(q),
      done: (e) => events.done.push(e),
      error: (e) => events.error.push(e)
    },
    spawn: (_file, args, options) => {
      const child = new FakeClaude()
      spawned.push({ args, options, child })
      return child as unknown as ChildProcess
    },
    killTree,
    os: 'darwin',
    tmpDir: dir,
    ...(timeouts ? { timeouts } : {})
  })
}

beforeEach(async () => {
  ;({ repo, dir, projectId } = testRepository())
  account = repo.get().accounts[0]
  mkdirSync(account.configDir, { recursive: true })
  tokens = createSessionTokens()
  spawned = []
  events = { status: [], proposal: [], question: [], done: [], error: [] }
  // A kill makes the fake process exit, like a real SIGTERM.
  killTree = vi.fn((child: ChildProcess) => void (child as unknown as FakeClaude).exit(null))
  setup()
  server = await startMcpServer({
    tools: {
      ...createTools({
        repo,
        notes: { list: () => [], read: () => '', write: () => undefined },
        requestOpenSession: () => undefined,
        notifyStateChanged: () => undefined,
        confirm: () => Promise.resolve(false)
      }),
      ...createOptimizeTools({
        status: () => undefined,
        findings: () => undefined,
        ask: () => Promise.resolve(''),
        finish: () => undefined
      }),
      // Late-bound: `setup` may replace the manager after the server started.
      ...createAssistantTools({
        overview: (s) => manager.port.overview(s),
        sectionSchema: (s, x) => manager.port.sectionSchema(s, x),
        testGuard: (s, x) => manager.port.testGuard(s, x),
        classify: (s, x) => manager.port.classify(s, x),
        propose: (s, x) => manager.port.propose(s, x),
        ask: (s, x) => manager.port.ask(s, x)
      })
    },
    tokens,
    preferredPort: 0,
    rateLimit: { limit: 1000, windowMs: 60_000 }
  })
})

afterEach(async () => {
  manager.disposeAll()
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
  await server.stop()
})

const start = (prompt = 'Docker silmelerinde bana sor'): Promise<{ runId: string }> =>
  manager.start({ prompt, accountId: account.id, section: 'guard', projectId })

const PROPOSAL = {
  summary: 'Docker kategorisini engelle',
  reason: 'İstediğiniz gibi.',
  changes: [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'deny' } } }],
  examples: [{ input: 'docker system prune -af', expected: 'deny' }]
}

describe('settings assistant: claude arguments and stream', () => {
  it('turns every built-in tool off and allows only the assistant MCP tools', () => {
    const args = buildAssistantArgs({
      message: 'hi',
      promptFile: '/tmp/p.md',
      mcpUrl: 'http://127.0.0.1:1/mcp',
      sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false
    })
    expect(args.slice(0, 2)).toEqual(['-p', 'hi'])
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/p.md')
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual([
      'mcp__claudedeck__get_settings_overview',
      'mcp__claudedeck__get_section_schema',
      'mcp__claudedeck__test_guard',
      'mcp__claudedeck__classify_test_command',
      'mcp__claudedeck__propose_changes',
      'mcp__claudedeck__ask_user'
    ])
    for (const tool of ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'WebFetch']) {
      expect(DISALLOWED_TOOLS.split(',')).toContain(tool)
    }
    expect(args).toContain('--strict-mcp-config')
    expect(args.join(' ')).not.toMatch(/[0-9a-f]{64}/)
    expect(args.slice(-2)).toEqual(['--session-id', '00000000-0000-4000-8000-000000000000'])
    const resumed = buildAssistantArgs({
      message: 'x',
      promptFile: 'p',
      mcpUrl: 'u',
      sessionId: 's',
      resume: true
    })
    expect(resumed.slice(-2)).toEqual(['--resume', 's'])
  })

  it('maps stream-json lines to phases and the turn result', () => {
    expect(parseAssistantLine(JSON.stringify(toolUse('test_guard')))).toEqual([
      { kind: 'phase', phase: 'testing' }
    ])
    expect(parseAssistantLine(JSON.stringify(toolUse('get_section_schema')))).toEqual([
      { kind: 'phase', phase: 'reading' }
    ])
    expect(
      parseAssistantLine(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })
      )
    ).toEqual([{ kind: 'phase', phase: 'thinking' }])
    expect(parseAssistantLine(JSON.stringify(result('Bitti')))).toEqual([
      { kind: 'result', isError: false, text: 'Bitti' }
    ])
    expect(parseAssistantLine('not json')).toEqual([])
  })

  it('writes the request, section, project and language into the first message', () => {
    const message = initialMessage(
      { prompt: 'pytest kuyruğa', accountId: account.id, section: 'testQueue', projectId },
      repo.get(),
      'tr'
    )
    expect(message).toContain('pytest kuyruğa')
    expect(message).toContain('section the user is looking at: testQueue')
    expect(message).toContain(`App (id ${projectId})`)
    expect(message).toContain('in Turkish')
  })
})

describe('settings assistant: MCP scoping', () => {
  it('an assistant token sees only the assistant tools; tab and optimize tokens never see them', async () => {
    await start()
    const assistant = await connect(tokenOf())
    const names = (await assistant.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'ask_user',
      'classify_test_command',
      'get_section_schema',
      'get_settings_overview',
      'propose_changes',
      'test_guard'
    ])
    const tabCall = await assistant.callTool({ name: 'list_projects', arguments: {} })
    expect(tabCall.isError).toBe(true)

    const tab = await connect(tokens.issue({ sessionId: 'tab1', projectId, accountId: account.id }))
    const tabNames = (await tab.listTools()).tools.map((t) => t.name)
    expect(tabNames).toContain('list_projects')
    expect(tabNames).not.toContain('propose_changes')
    expect((await tab.callTool({ name: 'get_settings_overview', arguments: {} })).isError).toBe(
      true
    )

    const optimize = await connect(
      tokens.issue({ kind: 'optimize', runId: 'o1', accountId: account.id })
    )
    expect((await optimize.listTools()).tools.map((t) => t.name)).not.toContain(
      'get_settings_overview'
    )
  })

  it('refuses a token of another run, and the token dies with the run', async () => {
    const { runId } = await start()
    const stranger = await connect(
      tokens.issue({ kind: 'assistant', runId: 'other', accountId: account.id })
    )
    const refused = await stranger.callTool({ name: 'get_settings_overview', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe('Not allowed')
    const token = tokenOf()
    manager.cancel(runId)
    expect(tokens.lookup(token)).toBeNull()
  })
})

describe('settings assistant: a run end to end', () => {
  it("reads, proposes, applies on the user's click and cleans up", async () => {
    const { runId } = await start()
    const { args, options, child } = last()
    expect(args[1]).toMatch(/claude '-p' '.*Docker silmelerinde bana sor/s)
    expect(args[1]).toContain(`'--tools' ''`)
    const cwd = options.cwd as string
    expect(cwd).toContain('claudedeck-assistant-')
    const runDir = join(cwd, '..')
    expect(readFileSync(join(runDir, 'system-prompt.md'), 'utf8')).toBe('SETTINGS ASSISTANT PROMPT')
    expect(events.status).toEqual([{ runId, phase: 'starting' }])

    const claude = await connect(tokenOf())
    child.line(toolUse('get_settings_overview'))
    const overview = JSON.parse(
      textOf(await claude.callTool({ name: 'get_settings_overview', arguments: {} }))
    )
    expect(overview.sections.guard.current.categories.docker).toBe('ask')
    expect(events.status.map((s) => s.phase)).toEqual(['starting', 'reading'])

    const invalid = await claude.callTool({
      name: 'propose_changes',
      arguments: {
        ...PROPOSAL,
        changes: [{ section: 'guard', scope: 'global', patch: { categories: { docker: 'nope' } } }]
      }
    })
    expect(invalid.isError).toBe(true)
    expect(textOf(invalid)).toMatch(/changes\[0\]\.patch\.categories\.docker: must be one of/)

    const decision = claude.callTool({ name: 'propose_changes', arguments: PROPOSAL })
    const proposal = await until(() => events.proposal[0])
    expect(proposal).toMatchObject({
      runId,
      summary: 'Docker kategorisini engelle',
      confirmations: []
    })
    expect(proposal.examples[0]).toMatchObject({ before: 'ask', after: 'deny' })
    // Proposing writes nothing.
    expect(repo.get().settings.guard.categories.docker).toBe('ask')

    const applied = manager.apply(proposal.id, [])
    expect(applied).toMatchObject({ section: 'guard', keys: ['guard.categories.docker'] })
    expect(repo.get().settings.guard.categories.docker).toBe('deny')
    expect(textOf(await decision)).toMatch(/^applied:/)
    expect(events.done).toEqual([{ runId, outcome: 'applied' }])

    // Claude Code kept a transcript for follow-ups; it goes with the run.
    const transcripts = join(account.configDir, 'projects', encodeProjectKey(cwd))
    mkdirSync(transcripts, { recursive: true })
    writeFileSync(join(transcripts, 'session.jsonl'), '{}\n')
    child.line(result('Uygulandı.'))
    await child.exit(0)
    expect(existsSync(runDir)).toBe(false)
    expect(existsSync(transcripts)).toBe(false)
    expect(existsSync(account.configDir)).toBe(true)

    const undone = manager.undo(applied.undoToken)
    expect(undone.settings.guard.categories.docker).toBe('ask')
  })

  it('a refinement returns the note; Vazgeç ends the run', async () => {
    const { runId } = await start()
    const claude = await connect(tokenOf())
    const first = claude.callTool({ name: 'propose_changes', arguments: PROPOSAL })
    const proposal = await until(() => events.proposal[0])
    await manager.followUp(runId, 'Sadece prune için olsun')
    expect(textOf(await first)).toBe(
      'refine: the user wants changes before applying. User note: Sadece prune için olsun'
    )
    expect(() => manager.apply(proposal.id, [])).toThrow('INVALID')

    const second = claude.callTool({
      name: 'propose_changes',
      arguments: {
        ...PROPOSAL,
        changes: [
          {
            section: 'guard',
            scope: 'global',
            patch: { ruleOverrides: { 'docker.prune': 'deny' } }
          }
        ]
      }
    })
    const next = await until(() => events.proposal[1])
    manager.reject(next.id)
    expect(textOf(await second)).toMatch(/^cancelled: the user declined/)
    expect(events.done).toEqual([{ runId, outcome: 'rejected' }])
    expect(repo.get().settings.guard.ruleOverrides).toEqual({})
  })

  it('needs every confirmation the proposal lists before applying', async () => {
    await start()
    const claude = await connect(tokenOf())
    const decision = claude.callTool({
      name: 'propose_changes',
      arguments: {
        ...PROPOSAL,
        changes: [{ section: 'guard', scope: 'global', patch: { categories: { disk: 'allow' } } }],
        examples: []
      }
    })
    const proposal = await until(() => events.proposal[0])
    expect(proposal.confirmations).toEqual(['guardAllow:disk'])
    expect(() => manager.apply(proposal.id, [])).toThrow('INVALID')
    expect(repo.get().settings.guard.categories.disk).toBe('deny')
    manager.apply(proposal.id, ['guardAllow:disk'])
    expect(repo.get().settings.guard.categories.disk).toBe('allow')
    expect(textOf(await decision)).toMatch(/^applied:/)
  })

  it('asks at most two questions and takes the answer from a follow-up', async () => {
    const { runId } = await start()
    const claude = await connect(tokenOf())
    for (let i = 0; i < 2; i++) {
      const asked = claude.callTool({ name: 'ask_user', arguments: { question: `Soru ${i}?` } })
      const question = await until(() => events.question[i])
      expect(question).toMatchObject({ runId, text: `Soru ${i}?` })
      await manager.followUp(runId, `Cevap ${i}`)
      expect(textOf(await asked)).toBe(`Answer: Cevap ${i}`)
    }
    const third = await claude.callTool({
      name: 'ask_user',
      arguments: { question: 'Bir tane daha?' }
    })
    expect(third.isError).toBe(true)
    expect(textOf(third)).toMatch(/No more questions/)
  })

  it('a finished turn waits for a follow-up, which resumes the same conversation', async () => {
    const { runId } = await start()
    const first = last()
    const firstToken = tokenOf(first)
    first.child.line(result('Bu ayar hesaplarla ilgili, burada değiştirilemez.'))
    await first.child.exit(0)
    expect(events.done).toEqual([
      { runId, outcome: 'answered', message: 'Bu ayar hesaplarla ilgili, burada değiştirilemez.' }
    ])
    expect(tokens.lookup(firstToken)).toBeNull()

    await manager.followUp(runId, 'O zaman Docker için sor')
    expect(spawned).toHaveLength(2)
    const sessionId = first.args[1].match(/'--session-id' '([0-9a-f-]+)'/)?.[1]
    expect(sessionId).toBeTruthy()
    expect(last().args[1]).toContain(`'--resume' '${sessionId}'`)
    expect(last().args[1]).toContain(`'-p' 'O zaman Docker için sor'`)
    expect(last().options.cwd).toBe(first.options.cwd)
    expect(tokens.lookup(tokenOf())).toMatchObject({ kind: 'assistant', runId })
  })

  it("reports a failed turn with Claude's message and ends the run", async () => {
    const { runId } = await start()
    const { child } = last()
    child.line(result('Invalid API key', true))
    child.stderr.write('auth failed\n')
    await child.exit(1)
    expect(events.error).toEqual([
      { runId, code: 'FAILED', detail: 'Invalid API key\nauth failed' }
    ])
    await expect(manager.followUp(runId, 'tekrar')).rejects.toThrow('INVALID')
  })

  it('cancel answers a waiting proposal, kills Claude and removes the run folder', async () => {
    const { runId } = await start()
    const { options } = last()
    const claude = await connect(tokenOf())
    const pending = claude.callTool({ name: 'propose_changes', arguments: PROPOSAL })
    await until(() => events.proposal[0])
    manager.cancel(runId)
    expect(textOf(await pending)).toMatch(/^cancelled: the user closed the window/)
    expect(killTree).toHaveBeenCalledWith(last().child, 'SIGTERM')
    await until(() => (existsSync(join(options.cwd as string, '..')) ? undefined : true))
    expect(events.done).toEqual([{ runId, outcome: 'cancelled' }])
  })

  it('times out when Claude stays silent', async () => {
    setup({ silentMs: 30 })
    const { runId } = await start()
    await until(() => events.error[0])
    expect(events.error).toEqual([{ runId, code: 'TIMEOUT' }])
    expect(killTree).toHaveBeenCalled()
  })

  it('a new start replaces an open run', async () => {
    const first = await start()
    const firstToken = tokenOf()
    const second = await start('pytest kuyruğa')
    expect(second.runId).not.toBe(first.runId)
    expect(tokens.lookup(firstToken)).toBeNull()
    expect(events.done).toEqual([{ runId: first.runId, outcome: 'cancelled' }])
  })

  it('refuses empty or oversized prompts and unknown accounts', async () => {
    await expect(manager.start({ prompt: '  ', accountId: account.id })).rejects.toThrow('INVALID')
    await expect(
      manager.start({ prompt: 'x'.repeat(5000), accountId: account.id })
    ).rejects.toThrow('INVALID')
    await expect(manager.start({ prompt: 'x', accountId: 'nope' })).rejects.toThrow('NOT_FOUND')
    expect(spawned).toHaveLength(0)
  })
})
