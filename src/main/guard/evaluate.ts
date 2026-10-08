import type {
  GuardAction,
  GuardCategoryId,
  GuardCustomRule,
  GuardDecision,
  GuardSettings,
  ProjectGuard
} from '../../shared/types'
import { type Cmd, type ParseContext, parseCommandLine } from './commands'
import { matchesCommand, matchesRaw } from './custom'
import { databaseRules } from './detectors/database'
import { diskTools, forkBomb } from './detectors/disk'
import { dockerRules } from './detectors/docker'
import { fetchExecRules } from './detectors/fetchExec'
import { fileOps, fileToolHits } from './detectors/files'
import { gitRules } from './detectors/git'
import { publishRules } from './detectors/publish'
import { systemRules } from './detectors/system'
import type { CmdDetector, DetectContext, Hit } from './detectors/types'
import type { LocationEnv } from './locations'
import { parseCmd, parsePowerShell, parsePowerShellLine } from './powershell'
import { CATEGORY_NAMES, findRule } from './rules'

/**
 * The command guard: decides allow / ask / deny for one tool call. Pure and synchronous; it
 * never runs or reads anything. Every simple command of the input is checked and the most
 * severe result wins (deny > ask > allow).
 */

export interface GuardContext extends LocationEnv {
  settings: GuardSettings
  projectOverrides?: ProjectGuard
  /** Current branch of the working folder (rebase rule); null when not on a branch. */
  gitBranch?: string | null
}

/** Longer inputs are cut before parsing. */
export const MAX_GUARD_INPUT = 128 * 1024
/** Excerpts in reasons and the log. */
export const MAX_EXCERPT = 200

const DETECTORS: CmdDetector[] = [
  fileOps,
  diskTools,
  gitRules,
  fetchExecRules,
  dockerRules,
  databaseRules,
  publishRules,
  systemRules
]

const SEVERITY: Record<GuardAction, number> = { allow: 0, ask: 1, deny: 2 }

/** Tool calls whose input is a command line, and their shell. */
const COMMAND_TOOLS: Record<string, 'posix' | 'powershell'> = {
  Bash: 'posix',
  Monitor: 'posix',
  PowerShell: 'powershell'
}
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}

interface Scored {
  action: GuardAction
  category: GuardCategoryId | 'custom'
  ruleId: string
  what: string
  advice?: string
  detail?: string
  excerpt: string
}

/** Single line, control characters removed, cut to MAX_EXCERPT. */
export function excerpt(text: string): string {
  const line = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > MAX_EXCERPT ? `${line.slice(0, MAX_EXCERPT - 3)}...` : line
}

/** Action of a built-in rule: rule overrides, then category actions; project first. */
export function ruleAction(
  ruleId: string,
  category: GuardCategoryId,
  ctx: GuardContext
): GuardAction {
  const project = ctx.projectOverrides
  return (
    project?.ruleOverrides[ruleId] ??
    ctx.settings.ruleOverrides[ruleId] ??
    project?.categories[category] ??
    ctx.settings.categories[category]
  )
}

function score(h: Hit, ctx: GuardContext): Scored | null {
  const rule = findRule(h.ruleId)
  if (!rule) return null
  let action = ruleAction(rule.id, rule.category, ctx)
  if (h.cap === 'ask' && action === 'deny') action = 'ask'
  return {
    action,
    category: rule.category,
    ruleId: rule.id,
    what: rule.what,
    advice: rule.advice,
    detail: h.detail,
    excerpt: h.excerpt
  }
}

function customRules(ctx: GuardContext): GuardCustomRule[] {
  return [...ctx.settings.customRules, ...(ctx.projectOverrides?.customRules ?? [])]
}

const customScore = (rule: GuardCustomRule, text: string): Scored => ({
  action: rule.action,
  category: 'custom',
  ruleId: rule.id,
  what: `the custom rule "${rule.pattern.length > 60 ? `${rule.pattern.slice(0, 57)}...` : rule.pattern}"`,
  excerpt: text
})

/** Built-in and custom results for a command line; custom `allow` rules exempt their commands. */
function commandResults(input: string, cmds: Cmd[], ctx: GuardContext): Scored[] {
  const detect: DetectContext = { ...ctx, input }
  const rules = customRules(ctx)
  const results: Scored[] = []
  if (rules.some((r) => r.action === 'allow' && matchesRaw(r, input))) return []
  for (const rule of rules) {
    if (rule.action !== 'allow' && matchesRaw(rule, input)) results.push(customScore(rule, input))
  }
  cmds.forEach((cmd, index) => {
    const matching = rules.filter((r) => matchesCommand(r, cmd))
    if (matching.some((r) => r.action === 'allow')) return
    for (const rule of matching) results.push(customScore(rule, cmd.raw))
    for (const detector of DETECTORS) {
      for (const h of detector(cmd, index, detect, cmds)) {
        const s = score(h, ctx)
        if (s) results.push(s)
      }
    }
  })
  for (const h of forkBomb(detect)) {
    const s = score(h, ctx)
    if (s) results.push(s)
  }
  return results
}

function reasons(s: Scored): Pick<GuardDecision, 'reasonForModel' | 'messageForUser'> {
  const where = `ClaudeDeck guard (${CATEGORY_NAMES[s.category]})`
  const detail = s.detail ? ` (${s.detail})` : ''
  const shown = excerpt(s.excerpt)
  const cut = shown.length > 120 ? `${shown.slice(0, 117)}...` : shown
  if (s.action === 'deny') {
    return {
      reasonForModel:
        `${where}: ${s.what}${detail} is blocked. Do not retry it or work around the guard; ` +
        'tell the user what you wanted to run and why, so they can run it themselves or change ' +
        'the rule in ClaudeDeck settings.',
      messageForUser: `${where} blocked ${s.what}: ${cut}`
    }
  }
  return {
    reasonForModel: `${where}: ${s.what}${detail} is set to ask.${s.advice ? ` ${s.advice}` : ''}`,
    messageForUser: `${where}: ${s.what} needs your confirmation: ${cut}`
  }
}

/** Parser context with the PowerShell and cmd.exe parsers plugged in. */
const parseContext = (ctx: GuardContext): ParseContext => ({
  cwd: ctx.cwd,
  home: ctx.home,
  os: ctx.os,
  env: ctx.env,
  powershell: parsePowerShell,
  cmd: parseCmd
})

/** Parses a command line for a tool (`posix` for Bash and Monitor). */
export function parseFor(shell: 'posix' | 'powershell', input: string, ctx: GuardContext): Cmd[] {
  const text = input.slice(0, MAX_GUARD_INPUT)
  const pctx = parseContext(ctx)
  return (shell === 'powershell' ? parsePowerShellLine(text, pctx) : parseCommandLine(text, pctx))
    .cmds
}

/**
 * Decision for one tool call. `allow` comes back with the rule when a rule matched but is set
 * to allow, so the activity log can show it.
 */
export function evaluateGuard(
  toolName: string,
  toolInput: unknown,
  ctx: GuardContext
): GuardDecision {
  if (!ctx.settings.enabled) return { action: 'allow' }
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<
    string,
    unknown
  >
  let results: Scored[] = []
  const shell = COMMAND_TOOLS[toolName]
  if (shell) {
    if (typeof input.command !== 'string' || !input.command.trim()) return { action: 'allow' }
    const text = input.command.slice(0, MAX_GUARD_INPUT)
    results = commandResults(text, parseFor(shell, text, ctx), ctx)
  } else if (FILE_TOOLS[toolName]) {
    const path = input[FILE_TOOLS[toolName]]
    if (typeof path !== 'string' || !path) return { action: 'allow' }
    const detect: DetectContext = { ...ctx, input: path }
    results = fileToolHits(path, detect)
      .map((h) => score(h, ctx))
      .filter((s): s is Scored => !!s)
  } else {
    return { action: 'allow' }
  }
  if (!results.length) return { action: 'allow' }
  // Ties go to the first match, except that `sudo` gives way to what it runs.
  const top = results.reduce((best, s) =>
    SEVERITY[s.action] > SEVERITY[best.action] ||
    (SEVERITY[s.action] === SEVERITY[best.action] && best.ruleId === 'system.sudo')
      ? s
      : best
  )
  const base = { action: top.action, category: top.category, ruleId: top.ruleId }
  return top.action === 'allow' ? base : { ...base, ...reasons(top) }
}
