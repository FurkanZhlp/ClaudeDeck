import { GUARD_LIMITS } from '../../shared/guardLimits'
import { DomainError } from '../../shared/errors'
import type {
  Account,
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

/** Tools the hook sends; anything else is not checked. */
const TOOLS = new Set<GuardTool>([
  'Bash',
  'PowerShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit'
])
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_CWD = 4096

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
  account(id: string): Account | undefined
  /** ClaudeDeck's data folder (protected). */
  appDataDir: string
  home: string
  os: OsName
  env: Record<string, string | undefined>
  /** Current branch of a folder (rebase rule); omitted in tests. */
  gitBranch?: (cwd: string) => string | null
  log: GuardLog
}

export interface GuardService {
  /**
   * The guard step of a PreToolUse hook: a decision reply (deny or ask) or null when the call
   * may go ahead. Never throws: a failure becomes a deny reply.
   */
  check(scope: SessionScope, payload: unknown): string | null
  /** "Try a command" in Settings; nothing is logged. */
  evaluate(request: GuardEvaluateRequest): GuardDecision
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
  const value = tool === 'NotebookEdit' ? input.notebook_path : (input.command ?? input.file_path)
  return typeof value === 'string' ? excerpt(value) : ''
}

export function createGuardService(deps: GuardServiceDeps): GuardService {
  const context = (
    cwd: string | null,
    project: Project | undefined,
    accountId?: string
  ): GuardContext => {
    const account = accountId ? deps.account(accountId) : undefined
    return {
      cwd,
      home: deps.home,
      os: deps.os,
      env: deps.env,
      configDir: account?.configDir,
      appDataDir: deps.appDataDir,
      settings: deps.settings(),
      projectOverrides: project?.guard
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

  return {
    check(scope, payload) {
      try {
        if (!deps.settings().enabled) return null
        if (!isObject(payload) || typeof payload.tool_name !== 'string') return null
        const tool = payload.tool_name as GuardTool
        if (!TOOLS.has(tool)) return null
        const input = isObject(payload.tool_input) ? payload.tool_input : {}
        const project = deps.project(scope.projectId)
        const cwd =
          typeof payload.cwd === 'string' && payload.cwd.length <= MAX_CWD && payload.cwd
            ? payload.cwd
            : (project?.path ?? null)
        const text = subject(tool, input)
        const ctx = withBranch(context(cwd, project, scope.accountId), text)
        const decision = evaluateGuard(tool, input, ctx)
        if (decision.ruleId && decision.category) {
          const agentId =
            typeof payload.agent_id === 'string' && AGENT_ID.test(payload.agent_id)
              ? payload.agent_id
              : undefined
          deps.log.add({
            sessionId: scope.sessionId,
            projectId: scope.projectId,
            accountId: scope.accountId,
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

    evaluate(request) {
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
      const key =
        tool === 'NotebookEdit' ? 'notebook_path' : tool in FILE_TOOLS ? 'file_path' : 'command'
      return evaluateGuard(tool, { [key]: input }, ctx)
    }
  }
}

const FILE_TOOLS: Record<string, true> = {
  Write: true,
  Edit: true,
  MultiEdit: true,
  NotebookEdit: true
}
