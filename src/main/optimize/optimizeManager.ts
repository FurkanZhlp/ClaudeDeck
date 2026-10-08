import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { DomainError } from '../../shared/errors'
import { optimizeSupported } from '../../shared/optimizeSupport'
import type {
  Account,
  GuidelinesUpdate,
  OptimizeDecision,
  OptimizeEvent,
  OptimizeQuestion,
  OptimizeState,
  OptimizeStatus
} from '../../shared/types'
import { markOnboardingComplete } from '../accounts/accountService'
import { OptimizeRejection, type OptimizePort, type OptimizeToolName } from '../mcp/optimizeTools'
import { inlineMcpConfig, MCP_SERVER_NAME } from '../mcp/register'
import { MCP_TOKEN_ENV, type OptimizeScope, type SessionTokens } from '../mcp/sessionTokens'
import { platform, type OsName } from '../platform'
import { withEnvVars } from '../platform/env'
import { renameWithRetryAsync } from '../platform/fs'
import { ensureGuidelines } from '../profile/guidelines'
import { copyEntry, type CopyRunner } from '../profile/importer'
import { APP_MANAGED_USAGE_FILES } from '../usage/statuslineScript'
import { GUARD_KEY_FILE, HOOK_SCRIPT_FILE, LEGACY_HOOK_SCRIPT_FILE } from '../hooks/hookScript'
import { readSettingsText, restoreProtectedSettings } from './settingsGuard'

type Env = Record<string, string>

export const INITIAL_MESSAGE =
  'Start the ClaudeDeck profile optimization described in your system prompt. Explore the ' +
  'profile, report your findings with optimize_findings, then propose each change with ' +
  'optimize_ask, one at a time, and end with optimize_finish.'

export const CANCEL_REPLY = 'The user cancelled the optimization; stop now.'

const TOOL_NAMES: OptimizeToolName[] = [
  'optimize_status',
  'optimize_findings',
  'optimize_ask',
  'optimize_finish'
]
export const ALLOWED_TOOLS = TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`).join(',')
// PowerShell is the shell tool on Windows without Git Bash; unknown names are accepted
// (checked on Claude Code 2.1.282), so the list is the same everywhere.
export const DISALLOWED_TOOLS = 'Bash,PowerShell,WebFetch,WebSearch,Task,NotebookEdit'
/** Claude Code aborts MCP calls after ~60 s by default; optimize_ask waits for the user. */
export const MCP_TOOL_TIMEOUT_MS = '86400000'

const PROMPT_FILE = 'system-prompt.md'

/**
 * Folder for the system prompt file of a run, outside the profile (and so outside `--add-dir`).
 * Windows caps a command line at 32K characters, too short for the prompt as an argument.
 */
export const promptDir = (runId: string, tmp: string = tmpdir()): string =>
  join(tmp, `claudedeck-${runId}`)

/** Profile entries ClaudeDeck snapshots before a run and restores on revert. */
export const SNAPSHOT_ITEMS = [
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'output-styles',
  'settings.json',
  join('claudedeck', 'instructions')
]

const ACTIVITY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit'])
const ACTIVE = new Set<OptimizeStatus>(['starting', 'running', 'waiting'])
const MAX_EVENTS = 500
const MAX_TARGET = 200
const MAX_RESULT_SUMMARY = 4000
const STDERR_TAIL = 1500
// Tool results (file contents) arrive on stdout too; a longer line is dropped unparsed.
const MAX_LINE = 4 * 1024 * 1024
const KILL_GRACE_MS = 3000

/** Empty cwd for the optimize run; the profile itself is added with `--add-dir`. */
export const optimizeWorkspace = (configDir: string): string =>
  join(configDir, 'claudedeck', 'workspace')

export const backupsDir = (configDir: string): string => join(configDir, 'claudedeck', 'backups')

const settingsFile = (configDir: string): string => join(configDir, 'settings.json')

/** ISO time usable in a folder name. */
const stamp = (at: number): string => new Date(at).toISOString().replace(/:/g, '-')

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value

const FINISH_EXIT_GRACE_MS = 60_000

/**
 * App-managed files under `claudedeck/` that Claude may read but never edit: the statusline
 * scripts run on every prompt, so editing them would run code later. Deny always wins over
 * allow in Claude Code and a rule cannot carve out an exception, so the files are listed one by
 * one; `claudedeck/instructions/` (edited by the run) and `claudedeck/workspace/` stay open.
 */
export const APP_MANAGED_FILES = [
  'claudedeck/guidelines.md',
  'claudedeck/backups/**',
  ...APP_MANAGED_USAGE_FILES.map((name) => `claudedeck/${name}`),
  // Runs on every guarded tool call of the account (command guard and test queue).
  `claudedeck/${HOOK_SCRIPT_FILE}`,
  `claudedeck/${LEGACY_HOOK_SCRIPT_FILE}`,
  // The account's guard key: a run must neither read nor replace it.
  `claudedeck/${GUARD_KEY_FILE}`
]

/**
 * The profile is an added directory, so it would be fully readable and editable. These rules
 * (verified on Claude Code 2.1.282: Read/Edit path rules, Edit covers every editing tool) keep
 * credentials, transcripts and app-managed files out of reach.
 */
export function profileDenyRules(
  configDir: string,
  rulePath: (abs: string) => string = platform.permissionRulePath
): string[] {
  const root = rulePath(configDir)
  const at = (rel: string): string => `${root}/${rel}`
  const private_ = [
    '.claude.json',
    '.credentials.json',
    'projects/**',
    'sessions/**',
    'history.jsonl',
    `claudedeck/${GUARD_KEY_FILE}`
  ]
  const readOnly = ['plugins/**', ...APP_MANAGED_FILES]
  return [
    ...private_.flatMap((rel) => [`Read(${at(rel)})`, `Edit(${at(rel)})`]),
    ...readOnly.map((rel) => `Edit(${at(rel)})`)
  ]
}

/** Arguments for `claude`; the token only travels in the env (`${CLAUDEDECK_MCP_TOKEN}`). */
export function buildClaudeArgs(opts: {
  prompt: string
  configDir: string
  mcpUrl: string
  /** When set, the prompt is read from this file instead of the command line. */
  promptFile?: string
}): string[] {
  return [
    '-p',
    INITIAL_MESSAGE,
    ...(opts.promptFile
      ? ['--append-system-prompt-file', opts.promptFile]
      : ['--append-system-prompt', opts.prompt]),
    '--add-dir',
    opts.configDir,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--disallowedTools',
    DISALLOWED_TOOLS,
    // Passed as JSON, not CLI tool lists, because profile paths contain spaces.
    '--settings',
    JSON.stringify({ permissions: { deny: profileDenyRules(opts.configDir) } }),
    '--mcp-config',
    inlineMcpConfig(opts.mcpUrl),
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
}

export type StreamEvent =
  | { kind: 'activity'; tool: string; target?: string }
  | { kind: 'result'; isError: boolean; text: string }

/** Profile-relative path, or the file name for anything outside the profile. */
function profileTarget(value: unknown, configDir: string): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (!isAbsolute(value)) return clip(value, MAX_TARGET)
  const rel = relative(configDir, value)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  return clip(inside ? rel || '.' : basename(value), MAX_TARGET)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Maps one stream-json line to the few things the UI shows; everything else is dropped. */
export function parseStreamLine(line: string, configDir: string): StreamEvent[] {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObject(msg)) return []
  if (msg.type === 'result') {
    const text = typeof msg.result === 'string' ? msg.result : ''
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'success'
    const isError = msg.is_error === true || subtype !== 'success'
    return [{ kind: 'result', isError, text: text || (isError ? subtype : '') }]
  }
  if (msg.type !== 'assistant' || !isObject(msg.message)) return []
  const content = msg.message.content
  if (!Array.isArray(content)) return []
  const events: StreamEvent[] = []
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue
    if (!ACTIVITY_TOOLS.has(block.name)) continue
    const input = isObject(block.input) ? block.input : {}
    const target =
      block.name === 'Glob' || block.name === 'Grep'
        ? typeof input.pattern === 'string'
          ? clip(input.pattern, MAX_TARGET)
          : undefined
        : profileTarget(input.file_path, configDir)
    events.push(
      target === undefined
        ? { kind: 'activity', tool: block.name }
        : { kind: 'activity', tool: block.name, target }
    )
  }
  return events
}

/** A free folder name next to `base`. */
function freeDir(base: string): string {
  let dir = base
  for (let n = 1; existsSync(dir); n++) dir = `${base}-${n}`
  return dir
}

/** Copies whichever snapshot items exist into `backupDir` (never moves). Returns their names. */
export async function snapshotProfile(
  configDir: string,
  backupDir: string,
  copy: CopyRunner = platform.copyRunner
): Promise<string[]> {
  await mkdir(backupDir, { recursive: true })
  const copied: string[] = []
  for (const item of SNAPSHOT_ITEMS) {
    const src = join(configDir, item)
    if (!existsSync(src)) continue
    const dest = join(backupDir, item)
    await mkdir(dirname(dest), { recursive: true })
    await copyEntry(src, dest, false, copy, [configDir])
    copied.push(item)
  }
  return copied
}

/**
 * Moves the current snapshot items into `revertedDir`, then copies the snapshot back. Items that
 * did not exist at snapshot time end up only in `revertedDir`.
 */
export async function restoreSnapshot(
  configDir: string,
  backupDir: string,
  revertedDir: string,
  copy: CopyRunner = platform.copyRunner
): Promise<void> {
  const rename = renameWithRetryAsync(platform.os)
  await mkdir(revertedDir, { recursive: true })
  for (const item of SNAPSHOT_ITEMS) {
    const current = join(configDir, item)
    if (!existsSync(current)) continue
    const dest = join(revertedDir, item)
    await mkdir(dirname(dest), { recursive: true })
    await rename(current, dest)
  }
  for (const item of SNAPSHOT_ITEMS) {
    const saved = join(backupDir, item)
    if (!existsSync(saved)) continue
    const dest = join(configDir, item)
    await mkdir(dirname(dest), { recursive: true })
    await copyEntry(saved, dest, false, copy, [configDir])
  }
}

export type Spawner = (file: string, args: string[], options: SpawnOptions) => ChildProcess

export interface OptimizeManagerDeps {
  /** Throws DomainError('NOT_FOUND') for an unknown account. */
  account(accountId: string): Account
  claudeAvailable(): Promise<boolean>
  /** The user's login shell env (resolveShellEnv). */
  baseEnv(): Promise<Env>
  tokens: Pick<SessionTokens, 'issue' | 'revoke'>
  /** URL of the running MCP server, or null when it is not running. */
  mcpUrl(): string | null
  prompt: string
  guidelinesText: string
  emit(state: OptimizeState): void
  onGuidelinesUpdated?(update: GuidelinesUpdate): void
  /** The run's claude exited and protected settings were checked (re-sync app hooks). */
  onRunEnded?(accountId: string): void
  spawn?: Spawner
  /** Kills the run's whole process group. */
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void
  copy?: CopyRunner
  now?: () => number
  newId?: () => string
  /** Defaults to optimizeSupported(process.platform). */
  supported?: boolean
  /** Decides how the prompt is passed and how env names compare; defaults to the running OS. */
  os?: OsName
  /** Parent of the per-run prompt folder; defaults to the OS temp dir. */
  tmpDir?: string
}

interface Run {
  id: string
  configDir: string
  state: OptimizeState
  child: ChildProcess | null
  exited: boolean
  pending: { question: OptimizeQuestion; resolve: (reply: string) => void } | null
  questionIds: Set<string>
  stdoutBuffer: string
  skippingLine: boolean
  stderrTail: string
  result: { isError: boolean; text: string } | null
  killTimer: NodeJS.Timeout | null
  /** Temp folder of the prompt file (Windows), removed when the run ends. */
  promptDir: string | null
  /**
   * settings.json text right before Claude started (null: no file); undefined until then.
   * Protected keys are put back to it when the run ends.
   */
  settingsBefore?: string | null
}

const idleState = (accountId: string): OptimizeState => ({
  accountId,
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  backupDir: null,
  events: [],
  pending: null,
  reverted: false
})

const copyState = (state: OptimizeState): OptimizeState => ({
  ...state,
  events: state.events.slice()
})

/** One headless optimize run per account; Claude drives it through the optimize MCP tools. */
export class OptimizeManager {
  private readonly runs = new Map<string, Run>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly spawnFn: Spawner
  private readonly killTree: (child: ChildProcess, signal: NodeJS.Signals) => void

  /** Implementation of the optimize MCP tools, bound to the run that owns the token. */
  readonly port: OptimizePort

  constructor(private readonly deps: OptimizeManagerDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.spawnFn = deps.spawn ?? nodeSpawn
    this.killTree = deps.killTree ?? platform.killTree
    this.port = {
      status: (scope, message) => {
        const run = this.activeRun(scope)
        this.push(run, { type: 'status', message, at: this.now() })
        this.emit(run)
      },
      findings: (scope, f) => {
        const run = this.activeRun(scope)
        this.push(run, { type: 'findings', ...f, at: this.now() })
        this.emit(run)
      },
      ask: (scope, proposal) => this.ask(scope, proposal),
      finish: (scope, result) => {
        const run = this.activeRun(scope)
        if (run.pending) throw new OptimizeRejection('A question is still waiting for the user.')
        const at = this.now()
        this.push(run, { type: 'finish', ...result, at })
        run.state.status = 'finished'
        run.state.finishedAt = at
        this.emit(run)
        // Claude normally exits right after finishing; do not let a stuck process block revert.
        const child = run.child
        if (child && !run.exited) {
          run.killTimer = setTimeout(() => {
            if (!run.exited) this.killTree(child, 'SIGTERM')
          }, FINISH_EXIT_GRACE_MS)
          run.killTimer.unref?.()
        }
      }
    }
  }

  get(accountId: string): OptimizeState {
    this.deps.account(accountId)
    const run = this.runs.get(accountId)
    return run ? copyState(run.state) : idleState(accountId)
  }

  /** True while a run of the account is starting, running or waiting for the user. */
  isActive(accountId: string): boolean {
    const status = this.runs.get(accountId)?.state.status
    return status !== undefined && ACTIVE.has(status)
  }

  list(): OptimizeState[] {
    return [...this.runs.values()].map((run) => copyState(run.state))
  }

  async start(accountId: string): Promise<OptimizeState> {
    if (!(this.deps.supported ?? optimizeSupported(process.platform)))
      throw new DomainError('UNSUPPORTED')
    const account = this.deps.account(accountId)
    const previous = this.runs.get(accountId)
    if (previous && ACTIVE.has(previous.state.status)) throw new DomainError('INVALID')

    // Reserved right away so a second start during the awaits below is refused.
    const run: Run = {
      id: `optimize-${this.newId()}`,
      configDir: account.configDir,
      state: { ...idleState(accountId), status: 'starting', startedAt: this.now() },
      child: null,
      exited: false,
      pending: null,
      questionIds: new Set(),
      stdoutBuffer: '',
      skippingLine: false,
      stderrTail: '',
      result: null,
      killTimer: null,
      promptDir: null
    }
    this.runs.set(accountId, run)

    let child: ChildProcess
    try {
      if (!(await this.deps.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
      const mcpUrl = this.deps.mcpUrl()
      if (!mcpUrl) {
        console.warn('[optimize] MCP server is not running')
        throw new DomainError('UNKNOWN')
      }
      const base = await this.deps.baseEnv()
      this.prepareProfile(account)
      const backupDir = freeDir(
        join(backupsDir(account.configDir), `optimize-${stamp(this.now())}`)
      )
      await snapshotProfile(account.configDir, backupDir, this.deps.copy)
      run.state.backupDir = backupDir
      const workspace = optimizeWorkspace(account.configDir)
      platform.rmWithRetry(workspace, { recursive: true, force: true })
      mkdirSync(workspace, { recursive: true })
      const args = buildClaudeArgs({
        prompt: this.deps.prompt,
        configDir: account.configDir,
        mcpUrl,
        promptFile: this.writePromptFile(run)
      })
      // Cancelled (or app quit) during the awaits above: nothing was started.
      if (run.state.status !== 'starting') {
        this.removePromptDir(run)
        return copyState(run.state)
      }
      run.settingsBefore = readSettingsText(settingsFile(account.configDir))
      const launch = platform.claudeLaunch(account.configDir, args, base)
      const token = this.deps.tokens.issue({ kind: 'optimize', runId: run.id, accountId })
      child = this.spawnFn(launch.file, launch.args, {
        cwd: workspace,
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
      this.removePromptDir(run)
      if (this.runs.get(accountId) === run) {
        if (previous) this.runs.set(accountId, previous)
        else this.runs.delete(accountId)
      }
      this.deps.emit(previous ? copyState(previous.state) : idleState(accountId))
      throw error
    }

    run.child = child
    this.attach(run, child)
    run.state.status = 'running'
    this.emit(run)
    console.info('[optimize] started', accountId, run.id)
    return copyState(run.state)
  }

  answer(
    accountId: string,
    questionId: string,
    decision: OptimizeDecision,
    note?: string
  ): OptimizeState {
    const run = this.runs.get(accountId)
    const pending = run?.pending
    if (!run || !pending || pending.question.id !== questionId) throw new DomainError('INVALID')
    const trimmed = note?.trim() || undefined
    if (decision === 'modify' && !trimmed) throw new DomainError('INVALID')
    const reply =
      decision === 'modify' ? `Decision: modify. User note: ${trimmed}` : `Decision: ${decision}`
    run.pending = null
    run.state.pending = null
    run.state.status = 'running'
    this.push(run, {
      type: 'answer',
      answer: {
        questionId,
        decision,
        ...(decision === 'modify' ? { note: trimmed } : {}),
        answeredAt: this.now()
      },
      at: this.now()
    })
    this.emit(run)
    pending.resolve(reply)
    return copyState(run.state)
  }

  cancel(accountId: string): OptimizeState {
    const run = this.runs.get(accountId)
    if (!run || !ACTIVE.has(run.state.status)) throw new DomainError('INVALID')
    this.stop(run)
    this.emit(run)
    console.info('[optimize] cancelled', accountId, run.id)
    return copyState(run.state)
  }

  async revert(accountId: string): Promise<OptimizeState> {
    const run = this.runs.get(accountId)
    const backupDir = run?.state.backupDir
    if (!run || !backupDir || run.state.reverted || ACTIVE.has(run.state.status)) {
      throw new DomainError('INVALID')
    }
    // A finished run may still be shutting down; never race its last edits.
    if (run.child && !run.exited) throw new DomainError('INVALID')
    const revertedDir = freeDir(join(backupsDir(run.configDir), `reverted-${stamp(this.now())}`))
    await restoreSnapshot(run.configDir, backupDir, revertedDir, this.deps.copy)
    run.state.reverted = true
    this.emit(run)
    console.info('[optimize] reverted', accountId, run.id)
    return copyState(run.state)
  }

  /** Kills every running optimize process (app quit). */
  disposeAll(): void {
    for (const run of this.runs.values()) {
      if (ACTIVE.has(run.state.status)) this.stop(run)
    }
  }

  private ask(scope: OptimizeScope, proposal: Parameters<OptimizePort['ask']>[1]): Promise<string> {
    const run = this.activeRun(scope)
    if (run.pending) {
      throw new OptimizeRejection('Another question is already waiting for the user.')
    }
    let id = proposal.id
    for (let n = 2; run.questionIds.has(id); n++) id = `${proposal.id}-${n}`
    run.questionIds.add(id)
    const question: OptimizeQuestion = {
      id,
      title: proposal.title,
      rationale: proposal.rationale,
      files: proposal.files,
      ...(proposal.preview !== undefined ? { preview: proposal.preview } : {}),
      askedAt: this.now()
    }
    return new Promise<string>((resolve) => {
      run.pending = { question, resolve }
      run.state.pending = question
      run.state.status = 'waiting'
      this.push(run, { type: 'question', question, at: question.askedAt })
      this.emit(run)
    })
  }

  private activeRun(scope: OptimizeScope): Run {
    const run = this.runs.get(scope.accountId)
    if (!run || run.id !== scope.runId || !ACTIVE.has(run.state.status)) {
      throw new OptimizeRejection('Not allowed')
    }
    return run
  }

  /** Cancels a run: answers a waiting question, kills the process group, drops the token. */
  private stop(run: Run): void {
    run.state.status = 'cancelled'
    run.state.finishedAt = this.now()
    this.releasePending(run)
    this.deps.tokens.revoke(run.id)
    const child = run.child
    if (!child || run.exited) return
    this.killTree(child, 'SIGTERM')
    run.killTimer = setTimeout(() => {
      if (!run.exited) this.killTree(child, 'SIGKILL')
    }, KILL_GRACE_MS)
    run.killTimer.unref?.()
  }

  private releasePending(run: Run): void {
    const pending = run.pending
    run.pending = null
    run.state.pending = null
    pending?.resolve(CANCEL_REPLY)
  }

  /** Writes the prompt to a file on Windows; undefined elsewhere (passed inline). */
  private writePromptFile(run: Run): string | undefined {
    if ((this.deps.os ?? platform.os) !== 'win32') return undefined
    const dir = promptDir(run.id, this.deps.tmpDir)
    run.promptDir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, PROMPT_FILE)
    writeFileSync(file, this.deps.prompt, { encoding: 'utf8', mode: 0o600 })
    return file
  }

  private removePromptDir(run: Run): void {
    const dir = run.promptDir
    if (!dir) return
    run.promptDir = null
    try {
      platform.rmWithRetry(dir, { recursive: true, force: true })
    } catch (error) {
      console.warn('[optimize] could not remove the prompt folder', run.id, error)
    }
  }

  private prepareProfile(account: Account): void {
    mkdirSync(account.configDir, { recursive: true, mode: 0o700 })
    try {
      markOnboardingComplete(account.configDir)
    } catch (error) {
      console.warn('[optimize] could not mark onboarding complete', error)
    }
    try {
      const result = ensureGuidelines(account.configDir, this.deps.guidelinesText)
      if (result && result.from !== null) {
        this.deps.onGuidelinesUpdated?.({ accountId: account.id, ...result })
      }
    } catch (error) {
      console.warn('[optimize] could not install guidelines', error)
    }
  }

  private attach(run: Run, child: ChildProcess): void {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(run, chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      run.stderrTail = (run.stderrTail + chunk).slice(-STDERR_TAIL)
    })
    child.on('error', (error) => {
      console.warn('[optimize] process error', run.id, error)
      if (!run.result)
        run.result = { isError: true, text: `Could not start Claude: ${error.message}` }
      this.onClose(run, null)
    })
    child.on('close', (code) => this.onClose(run, code))
  }

  private onStdout(run: Run, chunk: string): void {
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
    let changed = false
    for (const event of parseStreamLine(line, run.configDir)) {
      if (event.kind === 'result') {
        run.result = { isError: event.isError, text: event.text }
        continue
      }
      if (!ACTIVE.has(run.state.status)) continue
      this.push(run, {
        type: 'activity',
        tool: event.tool,
        ...(event.target !== undefined ? { target: event.target } : {}),
        at: this.now()
      })
      changed = true
    }
    if (changed) this.emit(run)
  }

  private onClose(run: Run, code: number | null): void {
    if (run.exited) return
    run.exited = true
    if (run.killTimer) clearTimeout(run.killTimer)
    this.removePromptDir(run)
    this.deps.tokens.revoke(run.id)
    this.releasePending(run)
    const restored = this.guardSettings(run)
    if (ACTIVE.has(run.state.status)) {
      const at = this.now()
      if (run.result?.isError || code !== 0) {
        const reason = run.result?.isError
          ? run.result.text || 'Claude reported an error'
          : `Claude exited with code ${code ?? 'unknown'}`
        const tail = run.stderrTail.trim()
        run.state.status = 'failed'
        this.push(run, {
          type: 'error',
          message: tail ? `${reason}\n${tail.slice(-500)}` : reason,
          at
        })
      } else {
        // Claude stopped without optimize_finish; keep its last message as the summary.
        run.state.status = 'finished'
        const summary = clip(run.result?.text ?? '', MAX_RESULT_SUMMARY)
        if (summary) this.push(run, { type: 'finish', summary, changes: [], at })
      }
      run.state.finishedAt = at
    }
    if (restored.length > 0) this.reportRestored(run, restored)
    try {
      this.deps.onRunEnded?.(run.state.accountId)
    } catch (error) {
      console.warn('[optimize] run end hook failed', run.id, error)
    }
    this.emit(run)
    console.info('[optimize] exited', run.state.accountId, run.id, run.state.status)
  }

  /** Puts protected settings.json keys back once Claude can no longer write. */
  private guardSettings(run: Run): string[] {
    const before = run.settingsBefore
    if (before === undefined) return []
    try {
      const restored = restoreProtectedSettings(settingsFile(run.configDir), before)
      if (restored.length > 0) {
        console.warn('[optimize] restored protected settings', run.id, restored.join(', '))
      }
      return restored
    } catch (error) {
      console.warn('[optimize] could not check protected settings', run.id, error)
      return []
    }
  }

  /** Adds the restored keys to the finish summary's change list, or as a status line. */
  private reportRestored(run: Run, keys: string[]): void {
    const note = `ClaudeDeck undid changes to protected settings: ${keys.join(', ')}`
    const events = run.state.events
    const index = events.findLastIndex((e) => e.type === 'finish')
    const finish = events[index]
    if (finish?.type === 'finish') {
      events[index] = { ...finish, changes: [...finish.changes, note] }
    } else {
      this.push(run, { type: 'status', message: note, at: this.now() })
    }
  }

  /** Appends an event; past the cap the oldest activity goes first, then the oldest event. */
  private push(run: Run, event: OptimizeEvent): void {
    const events = run.state.events
    if (events.length >= MAX_EVENTS) {
      const oldest = events.findIndex((e) => e.type === 'activity')
      events.splice(oldest >= 0 ? oldest : 0, 1)
    }
    events.push(event)
  }

  private emit(run: Run): void {
    this.deps.emit(copyState(run.state))
  }
}
