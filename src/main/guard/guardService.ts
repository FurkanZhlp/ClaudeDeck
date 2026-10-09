import { realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import { GUARD_LIMITS } from '../../shared/guardLimits'
import { DomainError } from '../../shared/errors'
import type {
  Account,
  GuardAction,
  GuardDecision,
  GuardEvaluateRequest,
  GuardSettings,
  GuardTool,
  Project
} from '../../shared/types'
import type { SessionScope } from '../mcp/sessionTokens'
import type { OsName } from '../platform/types'
import { isObject } from '../profile/settingsFile'
import { evaluateGuard, excerpt, type GuardContext } from './evaluate'
import type { GuardLog } from './guardLog'
import type { EvaluateOptions, GuardRunner } from './guardRunner'
import { within } from './paths'

/** Tools the hook sends; anything else is not checked. */
const TOOLS = new Set<GuardTool>([
  'Bash',
  'PowerShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Grep'
])
const FILE_KEYS: Partial<Record<GuardTool, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Read: 'file_path',
  Grep: 'path'
}
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_CWD = 4096
/** Path segments climbed while looking for the existing part of a path. */
const MAX_REALPATH_LEVELS = 64

/** Reply when the guard itself fails: the call is denied, never let through unchecked. */
export const GUARD_ERROR_REPLY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      'ClaudeDeck command guard could not check this tool call, so it was blocked. Tell the user.'
  },
  systemMessage: 'ClaudeDeck command guard could not check a tool call; it was blocked.'
})

export interface GuardServiceDeps {
  settings(): GuardSettings
  project(id: string): Project | undefined
  /** Every project (guard-only hook calls find theirs by folder). */
  projects?(): Project[]
  account(id: string): Account | undefined
  /** ClaudeDeck's data folder (protected). */
  appDataDir: string
  home: string
  os: OsName
  env: Record<string, string | undefined>
  /** Current branch of a folder (rebase rule); omitted in tests. */
  gitBranch?: (cwd: string) => string | null
  /**
   * Runs the evaluator off the main thread with a time limit; without it (tests) the
   * evaluator runs inline.
   */
  runner?: GuardRunner
  /** `realpathSync.native`; tests pass fakes. Errors mean "does not exist". */
  realpath?: (path: string) => string
  log: GuardLog
  /** Port of the hook server while it runs (`lsof -ti :PORT | xargs kill`). */
  hookPort?: () => number | null
  /** ClaudeDeck's own process ids (`kill -STOP <pid>`). */
  ownPids?: readonly number[]
}

/** Who a hook call comes from: a tab (its token) or only an account (its guard key). */
export type GuardCaller = SessionScope | { kind: 'account'; accountId: string }

export interface GuardService {
  /**
   * The guard step of a PreToolUse hook: a decision reply (deny or ask) or null when the call
   * may go ahead. Never rejects: a failure becomes a deny reply.
   */
  check(caller: GuardCaller, payload: unknown, signal?: AbortSignal): Promise<string | null>
  /** "Try a command" in Settings; nothing is logged. */
  evaluate(request: GuardEvaluateRequest): Promise<GuardDecision>
}

/** PreToolUse JSON for an ask or deny decision. */
export function decisionReply(decision: GuardDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.action,
      permissionDecisionReason: decision.reasonForModel
    },
    systemMessage: decision.messageForUser
  })
}

/** The command or path a tool call is about (for the log). */
function subject(tool: GuardTool, input: Record<string, unknown>): string {
  const value =
    tool === 'NotebookEdit'
      ? input.notebook_path
      : tool === 'Grep'
        ? input.path
        : (input.command ?? input.file_path)
  return typeof value === 'string' ? excerpt(value) : ''
}

const SEVERITY: Record<GuardAction, number> = { allow: 0, ask: 1, deny: 2 }

/** The more severe of two decisions (the first on a tie). */
const severest = (a: GuardDecision, b: GuardDecision): GuardDecision =>
  SEVERITY[b.action] > SEVERITY[a.action] ? b : a

/**
 * The path with symlinks resolved in its longest existing part (the file itself may not exist
 * yet). realpath only reads directory entries and links, it never opens the file, so a FIFO
 * cannot block it. Null when nothing changes or the path cannot be resolved.
 */
export function resolvedPath(
  path: string,
  realpath: (path: string) => string,
  os: OsName
): string | null {
  const p = os === 'win32' ? nodePath.win32 : nodePath.posix
  if (!p.isAbsolute(path)) return null
  const full = p.resolve(path)
  let existing = full
  const rest: string[] = []
  for (let level = 0; level < MAX_REALPATH_LEVELS; level++) {
    try {
      const real = realpath(existing)
      const out = rest.length ? p.join(real, ...rest.reverse()) : real
      return out === full ? null : out
    } catch {
      const parent = p.dirname(existing)
      if (parent === existing) return null
      rest.push(p.basename(existing))
      existing = parent
    }
  }
  return null
}

export function createGuardService(deps: GuardServiceDeps): GuardService {
  const realpath = deps.realpath ?? ((path: string) => realpathSync.native(path))

  const context = (
    cwd: string | null,
    project: Project | undefined,
    accountId?: string
  ): GuardContext => {
    const account = accountId ? deps.account(accountId) : undefined
    const port = deps.hookPort?.() ?? null
    return {
      cwd,
      home: deps.home,
      os: deps.os,
      env: deps.env,
      configDir: account?.configDir,
      appDataDir: deps.appDataDir,
      settings: deps.settings(),
      projectOverrides: project?.guard,
      ...(port !== null ? { hookPort: port } : {}),
      ...(deps.ownPids ? { ownPids: deps.ownPids } : {})
    }
  }

  const withBranch = (ctx: GuardContext, text: string): GuardContext => {
    if (!deps.gitBranch || !/\bgit\b/.test(text) || ctx.cwd === null) return ctx
    try {
      return { ...ctx, gitBranch: deps.gitBranch(ctx.cwd) }
    } catch {
      return ctx
    }
  }

  const run = (
    tool: string,
    input: unknown,
    ctx: GuardContext,
    options?: EvaluateOptions
  ): Promise<GuardDecision> =>
    deps.runner
      ? deps.runner.evaluate(tool, input, ctx, options)
      : Promise.resolve(evaluateGuard(tool, input, ctx))

  /** File tools are checked on the path as given and on where its symlinks lead. */
  const decide = async (
    tool: GuardTool,
    input: Record<string, unknown>,
    ctx: GuardContext,
    options?: EvaluateOptions
  ): Promise<GuardDecision> => {
    const decision = await run(tool, input, ctx, options)
    const key = FILE_KEYS[tool]
    const path = key ? input[key] : undefined
    if (!key || typeof path !== 'string' || !path || decision.action === 'deny') return decision
    let real: string | null = null
    try {
      real = resolvedPath(path, realpath, deps.os)
    } catch {
      real = null
    }
    if (!real) return decision
    return severest(decision, await run(tool, { ...input, [key]: real }, ctx, options))
  }

  /** The project of a guard-only call: the account's project whose folder holds `cwd`. */
  const projectAt = (accountId: string, cwd: string | null): Project | undefined => {
    if (!cwd || !deps.projects) return undefined
    return deps
      .projects()
      .filter((p) => p.accountId === accountId && within(cwd, p.path, deps.os))
      .sort((a, b) => b.path.length - a.path.length)[0]
  }

  return {
    async check(caller, payload, signal) {
      try {
        if (!deps.settings().enabled) return null
        if (!isObject(payload) || typeof payload.tool_name !== 'string') return null
        const tool = payload.tool_name as GuardTool
        if (!TOOLS.has(tool)) return null
        const input = isObject(payload.tool_input) ? payload.tool_input : {}
        const given =
          typeof payload.cwd === 'string' && payload.cwd.length <= MAX_CWD && payload.cwd
            ? payload.cwd
            : null
        const project =
          caller.kind === 'session'
            ? deps.project(caller.projectId)
            : projectAt(caller.accountId, given)
        const cwd = given ?? project?.path ?? null
        const text = subject(tool, input)
        const ctx = withBranch(context(cwd, project, caller.accountId), text)
        const scope =
          caller.kind === 'session' ? `session:${caller.sessionId}` : `account:${caller.accountId}`
        const decision = await decide(tool, input, ctx, { scope, signal })
        if (decision.ruleId && decision.category) {
          const agentId =
            typeof payload.agent_id === 'string' && AGENT_ID.test(payload.agent_id)
              ? payload.agent_id
              : undefined
          deps.log.add({
            sessionId: caller.kind === 'session' ? caller.sessionId : '',
            projectId: caller.kind === 'session' ? caller.projectId : (project?.id ?? ''),
            accountId: caller.accountId,
            ...(agentId ? { agentId } : {}),
            tool,
            category: decision.category,
            ruleId: decision.ruleId,
            action: decision.action,
            excerpt: text
          })
        }
        return decision.action === 'allow' ? null : decisionReply(decision)
      } catch (error) {
        // The command itself is not logged: it may hold secrets.
        console.error('[guard] check failed', error instanceof Error ? error.message : error)
        return GUARD_ERROR_REPLY
      }
    },

    async evaluate(request) {
      if (!isObject(request)) throw new DomainError('INVALID')
      const tool = (request.tool ?? 'Bash') as GuardTool
      const { input, projectId } = request
      if (!TOOLS.has(tool) || typeof input !== 'string') throw new DomainError('INVALID')
      if (input.length > GUARD_LIMITS.maxEvaluateInput) throw new DomainError('INVALID')
      if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
        throw new DomainError('INVALID')
      }
      const project = projectId ? deps.project(projectId) : undefined
      if (projectId && !project) throw new DomainError('NOT_FOUND')
      const account = project ? deps.account(project.accountId) : undefined
      const ctx = withBranch(context(project?.path ?? deps.home, project, account?.id), input)
      return run(tool, { [FILE_KEYS[tool] ?? 'command']: input }, ctx)
    }
  }
}
