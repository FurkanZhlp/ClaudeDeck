import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainError } from '../../shared/errors'
import {
  ASSISTANT_LIMITS,
  isAssistantSection,
  type AssistantApplyResult,
  type AssistantChangeInput,
  type AssistantConfirmation,
  type AssistantDoneEvent,
  type AssistantErrorEvent,
  type AssistantPhase,
  type AssistantProposal,
  type AssistantQuestion,
  type AssistantSection,
  type AssistantStartInput,
  type AssistantStartResult,
  type AssistantStatusEvent
} from '../../shared/assistant'
import type { Account, AppState, Language } from '../../shared/types'
import {
  AssistantRejection,
  ASSISTANT_TOOL_NAMES,
  type AssistantPort,
  type AssistantToolName
} from '../mcp/assistantTools'
import { inlineMcpConfig, MCP_SERVER_NAME } from '../mcp/register'
import { MCP_TOKEN_ENV, type AssistantScope, type SessionTokens } from '../mcp/sessionTokens'
import { encodeProjectKey } from '../notes/memoryPath'
import { platform, type OsName } from '../platform'
import { withEnvVars } from '../platform/env'
import { buildProposal, highlightKeys, type Evaluators } from './proposals'
import { AssistantValidationError, sectionSchema, settingsOverview } from './settingsSpec'
import type { SettingsWriter } from './settingsWriter'

type Env = Record<string, string>

export const ALLOWED_TOOLS = ASSISTANT_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`).join(
  ','
)
/**
 * `--tools ""` already turns every built-in tool off; the deny list is a second fence in case a
 * Claude Code version ignores it. Unknown names are accepted.
 */
export const DISALLOWED_TOOLS =
  'Bash,PowerShell,Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,Monitor'
/** Claude Code aborts MCP calls after ~60 s by default; proposals wait for the user. */
export const MCP_TOOL_TIMEOUT_MS = '86400000'

/** Folder name prefix of a run; also guards the transcript cleanup. */
const RUN_DIR_PREFIX = 'claudedeck-assistant-'
const PROMPT_FILE = 'system-prompt.md'

export const DEFAULT_TIMEOUTS = {
  /** No output from Claude while it works. */
  silentMs: 3 * 60 * 1000,
  /** A proposal or question waiting for the user. */
  userMs: 30 * 60 * 1000,
  /** A finished turn waiting for a follow-up. */
  idleMs: 30 * 60 * 1000,
  /** Claude normally exits right after an applied or rejected proposal. */
  exitGraceMs: 20 * 1000
}
const KILL_GRACE_MS = 3000
const STDERR_TAIL = 1500
const MAX_LINE = 4 * 1024 * 1024
const MAX_DETAIL = 500
const MAX_MESSAGE = 2000

export const APPLIED_REPLY =
  'applied: the user applied the changes. Reply with one short sentence and stop.'
export const REJECTED_REPLY =
  'cancelled: the user declined the proposal. Stop now without proposing again.'
export const CANCELLED_REPLY = 'cancelled: the user closed the window. Stop now.'
export const refineReply = (note: string): string =>
  `refine: the user wants changes before applying. User note: ${note}`

const TOOL_PHASES: Partial<Record<AssistantToolName, AssistantPhase>> = {
  get_settings_overview: 'reading',
  get_section_schema: 'reading',
  test_guard: 'testing',
  classify_test_command: 'testing',
  propose_changes: 'proposing'
}

const LANGUAGE_NAMES: Record<Language, string> = { tr: 'Turkish', en: 'English' }

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export type StreamInfo =
  { kind: 'phase'; phase: AssistantPhase } | { kind: 'result'; isError: boolean; text: string }

/** The few things a stream-json line tells the window: what Claude does, and the turn's end. */
export function parseAssistantLine(line: string): StreamInfo[] {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObject(msg)) return []
  if (msg.type === 'result') {
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'success'
    const isError = msg.is_error === true || subtype !== 'success'
    const text = typeof msg.result === 'string' ? msg.result : ''
    return [{ kind: 'result', isError, text: text || (isError ? subtype : '') }]
  }
  if (msg.type !== 'assistant' || !isObject(msg.message) || !Array.isArray(msg.message.content)) {
    return []
  }
  const out: StreamInfo[] = []
  const prefix = `mcp__${MCP_SERVER_NAME}__`
  for (const block of msg.message.content) {
    if (!isObject(block)) continue
    if (
      block.type === 'tool_use' &&
      typeof block.name === 'string' &&
      block.name.startsWith(prefix)
    ) {
      const phase = TOOL_PHASES[block.name.slice(prefix.length) as AssistantToolName]
      if (phase) out.push({ kind: 'phase', phase })
    } else if (block.type === 'text' || block.type === 'thinking') {
      out.push({ kind: 'phase', phase: 'thinking' })
    }
  }
  return out
}

/** Arguments for one turn of `claude`; the token only travels in the env. */
export function buildAssistantArgs(opts: {
  message: string
  promptFile: string
  mcpUrl: string
  sessionId: string
  resume: boolean
}): string[] {
  return [
    '-p',
    opts.message,
    '--append-system-prompt-file',
    opts.promptFile,
    // No built-in tools at all: no shell, files or web. Only the ClaudeDeck MCP tools below.
    '--tools',
    '',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--disallowedTools',
    DISALLOWED_TOOLS,
    '--permission-mode',
    'default',
    '--mcp-config',
    inlineMcpConfig(opts.mcpUrl),
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose',
    // Follow-ups after a finished turn continue the same conversation.
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId
  ]
}

/** First message of a run: the request plus the context Claude needs to resolve it. */
export function initialMessage(
  input: AssistantStartInput,
  state: AppState,
  language: Language
): string {
  const project = state.projects.find((p) => p.id === input.projectId)
  return [
    'Request from the ClaudeDeck settings window (the user typed it):',
    '"""',
    input.prompt,
    '"""',
    `Settings section the user is looking at: ${input.section ?? 'none'}.`,
    project
      ? `Selected project ("this project"): ${project.name} (id ${project.id}).`
      : 'No project is selected.',
    `Write every user-facing text (summary, reason, questions, replies) in ${LANGUAGE_NAMES[language]}.`
  ].join('\n')
}

export type Spawner = (file: string, args: string[], options: SpawnOptions) => ChildProcess

export interface AssistantEvents {
  status(event: AssistantStatusEvent): void
  proposal(proposal: AssistantProposal): void
  question(question: AssistantQuestion): void
  done(event: AssistantDoneEvent): void
  error(event: AssistantErrorEvent): void
}

export interface AssistantManagerDeps {
  /** Throws DomainError('NOT_FOUND') for an unknown account. */
  account(accountId: string): Account
  claudeAvailable(): Promise<boolean>
  baseEnv(): Promise<Env>
  tokens: Pick<SessionTokens, 'issue' | 'revoke'>
  mcpUrl(): string | null
  /** System prompt appended for every turn. */
  prompt: string
  state(): AppState
  /** Language of the user-facing texts. */
  language(): Language
  evaluators: Evaluators
  writer: Pick<SettingsWriter, 'apply' | 'undo'>
  events: AssistantEvents
  spawn?: Spawner
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void
  newId?: () => string
  os?: OsName
  tmpDir?: string
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>
  /** Removes a folder tree (defaults to the platform's retrying rm). */
  rm?: (path: string) => void
}

type RunState = 'working' | 'proposal' | 'question' | 'idle' | 'ended'

interface PendingProposal {
  view: AssistantProposal
  changes: AssistantChangeInput[]
  resolve: (reply: string) => void
}

interface Run {
  id: string
  accountId: string
  configDir: string
  sessionId: string
  dir: string
  cwd: string
  promptFile: string
  state: RunState
  phase: AssistantPhase | null
  turns: number
  child: ChildProcess | null
  exited: boolean
  proposal: PendingProposal | null
  question: { id: string; resolve: (reply: string) => void } | null
  questions: number
  stdoutBuffer: string
  skippingLine: boolean
  stderrTail: string
  result: { isError: boolean; text: string } | null
  timer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  cleaned: boolean
}

/**
 * One "edit settings with Claude" run at a time (the main window has one settings view). Each
 * turn is a headless `claude -p` of the chosen account with no built-in tools and only the
 * settings assistant MCP tools, scoped to the run by a per-turn token.
 */
export class AssistantManager {
  private run: Run | null = null
  private readonly newId: () => string
  private readonly spawnFn: Spawner
  private readonly killTree: (child: ChildProcess, signal: NodeJS.Signals) => void
  private readonly timeouts: typeof DEFAULT_TIMEOUTS
  private readonly rm: (path: string) => void

  /** The settings assistant MCP tools, bound to the run that owns the token. */
  readonly port: AssistantPort

  constructor(private readonly deps: AssistantManagerDeps) {
    this.newId = deps.newId ?? randomUUID
    this.spawnFn = deps.spawn ?? nodeSpawn
    this.killTree = deps.killTree ?? platform.killTree
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
    this.rm = deps.rm ?? ((path) => platform.rmWithRetry(path, { recursive: true, force: true }))
    this.port = {
      overview: (scope) => {
        this.working(scope, 'reading')
        return settingsOverview(this.deps.state(), this.deps.evaluators.catalog)
      },
      sectionSchema: (scope, section) => {
        this.working(scope, 'reading')
        return sectionSchema(section, this.deps.evaluators.catalog)
      },
      testGuard: async (scope, request) => {
        this.working(scope, 'testing')
        const state = this.deps.state()
        if (request.projectId && !state.projects.some((p) => p.id === request.projectId)) {
          throw new AssistantRejection('Unknown projectId')
        }
        if (!state.settings.guard.enabled) {
          return { action: 'allow', note: 'The command guard is off, so nothing is checked.' }
        }
        const d = await this.deps.evaluators.evaluateGuard(request, state)
        return {
          action: d.action,
          ...(d.category ? { category: d.category } : {}),
          ...(d.ruleId ? { ruleId: d.ruleId } : {}),
          ...(d.reasonForModel ? { reason: d.reasonForModel } : {})
        }
      },
      classify: (scope, request) => {
        this.working(scope, 'testing')
        const state = this.deps.state()
        const project = state.projects.find((p) => p.id === request.projectId)
        if (request.projectId && !project) throw new AssistantRejection('Unknown projectId')
        const s = state.settings.testQueue
        const result = this.deps.evaluators.classify(request.command, {
          disabledBuiltins: s.disabledBuiltins,
          customPatterns: s.customPatterns,
          projectOverrides: project?.testQueue
        })
        return { ...result, queueEnabled: s.enabled }
      },
      propose: (scope, input) => this.propose(scope, input),
      ask: (scope, question) => this.ask(scope, question)
    }
  }

  /** Starts a run; a run still open (an earlier window) is cancelled first. */
  async start(input: AssistantStartInput): Promise<AssistantStartResult> {
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt || prompt.length > ASSISTANT_LIMITS.prompt) throw new DomainError('INVALID')
    if (input.section !== undefined && !isAssistantSection(input.section)) {
      throw new DomainError('INVALID')
    }
    if (input.projectId !== undefined && typeof input.projectId !== 'string') {
      throw new DomainError('INVALID')
    }
    const account = this.deps.account(input.accountId)
    if (this.run && this.run.state !== 'ended') this.end(this.run, 'cancelled', CANCELLED_REPLY)

    const id = `assistant-${this.newId()}`
    const run: Run = {
      id,
      accountId: account.id,
      configDir: account.configDir,
      sessionId: randomUUID(),
      dir: '',
      cwd: '',
      promptFile: '',
      state: 'working',
      phase: null,
      turns: 0,
      child: null,
      exited: true,
      proposal: null,
      question: null,
      questions: 0,
      stdoutBuffer: '',
      skippingLine: false,
      stderrTail: '',
      result: null,
      timer: null,
      killTimer: null,
      cleaned: false
    }
    this.run = run
    this.setPhase(run, 'starting')
    try {
      if (!(await this.deps.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
      const mcpUrl = this.mcpUrl()
      const env = await this.deps.baseEnv()
      if (run.state === 'ended') return { runId: id }
      this.prepareDir(run)
      const message = initialMessage({ ...input, prompt }, this.deps.state(), this.deps.language())
      this.spawnTurn(run, message, mcpUrl, env)
    } catch (error) {
      if (this.run === run) this.run = null
      this.cleanup(run)
      throw error
    }
    console.info('[assistant] started', run.accountId, id)
    return { runId: id }
  }

  /**
   * The user's next message: the answer to a waiting question, a refinement of a waiting
   * proposal, or a new turn after Claude finished its last one.
   */
  async followUp(runId: string, text: string): Promise<null> {
    const run = this.current(runId)
    const note = typeof text === 'string' ? text.trim() : ''
    if (!note || note.length > ASSISTANT_LIMITS.followUp) throw new DomainError('INVALID')
    if (run.question) {
      const { resolve } = run.question
      run.question = null
      this.resume(run)
      resolve(`Answer: ${note}`)
      return null
    }
    if (run.proposal) {
      const { resolve } = run.proposal
      run.proposal = null
      this.resume(run)
      resolve(refineReply(note))
      return null
    }
    if (run.state !== 'idle') throw new DomainError('INVALID')
    const mcpUrl = this.mcpUrl()
    const env = await this.deps.baseEnv()
    if (run.state !== 'idle') throw new DomainError('INVALID')
    run.state = 'working'
    this.setPhase(run, 'thinking')
    this.spawnTurn(run, note, mcpUrl, env)
    return null
  }

  /**
   * Applies the waiting proposal after the user's click. `confirmed` must list every
   * confirmation the proposal needs (the renderer asked them like manual edits do).
   */
  apply(proposalId: string, confirmed: readonly string[]): AssistantApplyResult {
    const run = this.run
    const pending = run?.proposal
    if (!run || !pending || pending.view.id !== proposalId) throw new DomainError('INVALID')
    const given = new Set(Array.isArray(confirmed) ? confirmed : [])
    if (pending.view.confirmations.some((c: AssistantConfirmation) => !given.has(c))) {
      throw new DomainError('INVALID')
    }
    const { state, undoToken } = this.deps.writer.apply(pending.changes)
    const changes = pending.view.changes
    const section: AssistantSection =
      changes.find((c) => c.scope === 'global')?.section ?? changes[0].section
    this.end(run, 'applied', APPLIED_REPLY)
    console.info('[assistant] applied', run.id)
    return { state, undoToken, section, keys: highlightKeys(changes, this.deps.evaluators) }
  }

  /** The user declined the waiting proposal; the run ends. */
  reject(proposalId: string): null {
    const run = this.run
    if (!run || !run.proposal || run.proposal.view.id !== proposalId) {
      throw new DomainError('INVALID')
    }
    this.end(run, 'rejected', REJECTED_REPLY)
    return null
  }

  cancel(runId: string): null {
    const run = this.run
    if (!run || run.id !== runId) throw new DomainError('INVALID')
    if (run.state !== 'ended') this.end(run, 'cancelled', CANCELLED_REPLY)
    return null
  }

  undo(token: string): AppState {
    if (typeof token !== 'string' || !token || token.length > 200) throw new DomainError('INVALID')
    return this.deps.writer.undo(token)
  }

  /** App quit: kill whatever runs and remove its files. */
  disposeAll(): void {
    const run = this.run
    if (!run) return
    if (run.state !== 'ended') this.end(run, 'cancelled', CANCELLED_REPLY, false)
    // The app may quit before the killed process reports its exit.
    this.cleanup(run)
  }

  /* ---------------------------------------------------------------------------------------- */

  private mcpUrl(): string {
    const url = this.deps.mcpUrl()
    if (url) return url
    console.warn('[assistant] MCP server is not running')
    throw new DomainError('UNKNOWN')
  }

  private current(runId: string): Run {
    const run = this.run
    if (!run || run.id !== runId || run.state === 'ended') throw new DomainError('INVALID')
    return run
  }

  /** The run a tool call belongs to; anything else is refused. */
  private owned(scope: AssistantScope): Run {
    const run = this.run
    if (!run || run.id !== scope.runId || run.accountId !== scope.accountId) {
      throw new AssistantRejection('Not allowed')
    }
    if (run.state === 'ended') throw new AssistantRejection('The run has ended. Stop now.')
    return run
  }

  private working(scope: AssistantScope, phase: AssistantPhase): Run {
    const run = this.owned(scope)
    if (run.state !== 'working') {
      throw new AssistantRejection('Wait for the user: a proposal or question is still open.')
    }
    this.setPhase(run, phase)
    return run
  }

  private async propose(
    scope: AssistantScope,
    input: Parameters<AssistantPort['propose']>[1]
  ): Promise<string> {
    const run = this.working(scope, 'proposing')
    let built
    try {
      built = await buildProposal(input, this.deps.state(), this.deps.evaluators)
    } catch (error) {
      if (error instanceof AssistantValidationError) throw new AssistantRejection(error.message)
      throw error
    }
    // The run may have been cancelled while the examples were evaluated.
    if (this.run !== run || run.state !== 'working') {
      throw new AssistantRejection('The run has ended. Stop now.')
    }
    const view: AssistantProposal = { id: this.newId(), runId: run.id, ...built.view }
    return new Promise<string>((resolve) => {
      run.proposal = { view, changes: input.changes, resolve }
      this.wait(run, 'proposal')
      this.deps.events.proposal(view)
    })
  }

  private ask(scope: AssistantScope, text: string): Promise<string> {
    const run = this.working(scope, 'thinking')
    if (run.questions >= ASSISTANT_LIMITS.questions) {
      throw new AssistantRejection(
        'No more questions in this run: make your best proposal and explain your assumption in the reason.'
      )
    }
    run.questions += 1
    const question: AssistantQuestion = { id: this.newId(), runId: run.id, text }
    return new Promise<string>((resolve) => {
      run.question = { id: question.id, resolve }
      this.wait(run, 'question')
      this.deps.events.question(question)
    })
  }

  private setPhase(run: Run, phase: AssistantPhase): void {
    if (run.phase === phase) return
    run.phase = phase
    this.deps.events.status({ runId: run.id, phase })
  }

  /** Claude waits for the user: the silence timer gives way to the user timer. */
  private wait(run: Run, state: 'proposal' | 'question'): void {
    run.state = state
    run.phase = null
    this.arm(run, this.timeouts.userMs)
  }

  /** The user answered: Claude works again. */
  private resume(run: Run): void {
    run.state = 'working'
    this.setPhase(run, 'thinking')
    this.arm(run, this.timeouts.silentMs)
  }

  private arm(run: Run, ms: number): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = setTimeout(() => this.onTimeout(run), ms)
    run.timer.unref?.()
  }

  private onTimeout(run: Run): void {
    if (this.run !== run || run.state === 'ended') return
    if (run.state === 'idle') {
      this.end(run, 'cancelled', CANCELLED_REPLY, false)
      return
    }
    console.warn('[assistant] timed out', run.id, run.state)
    this.end(run, 'failed', CANCELLED_REPLY)
    this.deps.events.error({ runId: run.id, code: 'TIMEOUT' })
  }

  /** Temp folder of the run: the prompt file and an empty working folder for Claude. */
  private prepareDir(run: Run): void {
    const base = join(
      this.deps.tmpDir ?? tmpdir(),
      `${RUN_DIR_PREFIX}${run.id.slice('assistant-'.length)}`
    )
    mkdirSync(join(base, 'work'), { recursive: true, mode: 0o700 })
    // Claude Code keys transcripts by the real path (macOS: /var is /private/var).
    run.dir = realpathSync(base)
    run.cwd = join(run.dir, 'work')
    run.promptFile = join(run.dir, PROMPT_FILE)
    writeFileSync(run.promptFile, this.deps.prompt, { encoding: 'utf8', mode: 0o600 })
  }

  private spawnTurn(run: Run, message: string, mcpUrl: string, base: Env): void {
    const args = buildAssistantArgs({
      message,
      promptFile: run.promptFile,
      mcpUrl,
      sessionId: run.sessionId,
      resume: run.turns > 0
    })
    run.turns += 1
    run.result = null
    run.stdoutBuffer = ''
    run.skippingLine = false
    run.stderrTail = ''
    const launch = platform.claudeLaunch(run.configDir, args, base)
    const token = this.deps.tokens.issue({
      kind: 'assistant',
      runId: run.id,
      accountId: run.accountId
    })
    let child: ChildProcess
    try {
      child = this.spawnFn(launch.file, launch.args, {
        cwd: run.cwd,
        env: withEnvVars(
          launch.env,
          { MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS, [MCP_TOKEN_ENV]: token },
          this.deps.os ?? platform.os
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...platform.spawnDefaults()
      })
    } catch (error) {
      this.deps.tokens.revoke(run.id)
      throw error
    }
    run.child = child
    run.exited = false
    this.arm(run, this.timeouts.silentMs)
    this.attach(run, child)
  }

  private attach(run: Run, child: ChildProcess): void {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(run, chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      run.stderrTail = (run.stderrTail + chunk).slice(-STDERR_TAIL)
    })
    child.on('error', (error) => {
      console.warn('[assistant] process error', run.id, error)
      if (!run.result)
        run.result = { isError: true, text: `Could not start Claude: ${error.message}` }
      this.onClose(run, child, null)
    })
    child.on('close', (code) => this.onClose(run, child, code))
  }

  private onStdout(run: Run, chunk: string): void {
    if (run.state === 'working') this.arm(run, this.timeouts.silentMs)
    let buffer = run.stdoutBuffer + chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (run.skippingLine) run.skippingLine = false
      else if (line.trim()) this.onLine(run, line)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_LINE) {
      buffer = ''
      run.skippingLine = true
    }
    run.stdoutBuffer = buffer
  }

  private onLine(run: Run, line: string): void {
    for (const info of parseAssistantLine(line)) {
      if (info.kind === 'result') run.result = { isError: info.isError, text: info.text }
      else if (run.state === 'working') this.setPhase(run, info.phase)
    }
  }

  private onClose(run: Run, child: ChildProcess, code: number | null): void {
    if (run.child !== child || run.exited) return
    run.exited = true
    if (run.killTimer) clearTimeout(run.killTimer)
    run.killTimer = null
    this.deps.tokens.revoke(run.id)
    if (run.state === 'ended') {
      this.cleanup(run)
      return
    }
    // A question or proposal cannot outlive the process that asked it.
    this.releasePending(run, CANCELLED_REPLY)
    const failed = run.result?.isError || code !== 0
    if (failed) {
      const reason = run.result?.isError
        ? run.result.text || 'Claude reported an error'
        : `Claude exited with code ${code ?? 'unknown'}`
      const tail = run.stderrTail.trim()
      this.end(run, 'failed', CANCELLED_REPLY)
      this.deps.events.error({
        runId: run.id,
        code: 'FAILED',
        detail: clip(tail ? `${reason}\n${tail.slice(-MAX_DETAIL)}` : reason, MAX_DETAIL * 2)
      })
      console.warn('[assistant] turn failed', run.id, code)
      return
    }
    run.state = 'idle'
    run.phase = null
    this.arm(run, this.timeouts.idleMs)
    const message = clip(run.result?.text.trim() ?? '', MAX_MESSAGE)
    this.deps.events.done({ runId: run.id, outcome: 'answered', ...(message ? { message } : {}) })
  }

  private releasePending(run: Run, reply: string): void {
    const pending = run.proposal?.resolve ?? run.question?.resolve
    run.proposal = null
    run.question = null
    pending?.(reply)
  }

  /**
   * Ends the run: answers a waiting tool call with `reply`, drops the token and stops Claude
   * (after a grace period when it was told to stop, at once otherwise). Files go once it exited.
   */
  private end(
    run: Run,
    outcome: 'applied' | 'rejected' | 'cancelled' | 'failed',
    reply: string,
    notify = true
  ): void {
    if (run.state === 'ended') return
    run.state = 'ended'
    if (run.timer) clearTimeout(run.timer)
    run.timer = null
    const answered = run.proposal !== null || run.question !== null
    this.releasePending(run, reply)
    const child = run.child
    if (child && !run.exited) {
      // Told to stop through a tool reply: give Claude a moment to finish its last message.
      const graceful = answered && (outcome === 'applied' || outcome === 'rejected')
      if (graceful) {
        run.killTimer = setTimeout(() => this.kill(run, child), this.timeouts.exitGraceMs)
        run.killTimer.unref?.()
      } else {
        this.deps.tokens.revoke(run.id)
        this.kill(run, child)
      }
    } else {
      this.deps.tokens.revoke(run.id)
      this.cleanup(run)
    }
    if (notify && outcome !== 'failed') this.deps.events.done({ runId: run.id, outcome })
    console.info('[assistant] ended', run.id, outcome)
  }

  private kill(run: Run, child: ChildProcess): void {
    if (run.exited) return
    this.deps.tokens.revoke(run.id)
    this.killTree(child, 'SIGTERM')
    run.killTimer = setTimeout(() => {
      if (!run.exited) this.killTree(child, 'SIGKILL')
    }, KILL_GRACE_MS)
    run.killTimer.unref?.()
  }

  /**
   * Removes the run folder and the transcript Claude Code kept for it (the conversation exists
   * only for follow-ups within the run).
   */
  private cleanup(run: Run): void {
    if (run.cleaned || !run.dir) return
    run.cleaned = true
    const transcripts = join(run.configDir, 'projects', encodeProjectKey(run.cwd))
    for (const path of [transcripts, run.dir]) {
      // Only folders this run created are removed.
      if (!path.includes(RUN_DIR_PREFIX.replace(/[^a-zA-Z0-9]/g, '-')) && path !== run.dir) continue
      try {
        if (existsSync(path)) this.rm(path)
      } catch (error) {
        console.warn('[assistant] could not remove', path, error)
      }
    }
  }
}
