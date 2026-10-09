import { GUARD_CONFIRM_ALLOW, GUARD_LIMITS } from '@shared/guardLimits'
import { isSafeRegex } from '@shared/safeRegex'
import type {
  GuardAction,
  GuardCategoryId,
  GuardLogEntry,
  GuardRuleInfo,
  GuardSettings,
  ProjectGuard,
  TestQueueHookStatus
} from '@shared/types'
import { checkPattern } from '../testQueue/queueModel'

/** Per-rule choice in Settings: follow the category, or a fixed action. */
export const FOLLOW_CATEGORY = 'category'
export type RuleChoice = GuardAction | typeof FOLLOW_CATEGORY

/** Project category choice: the global action, or a fixed action. */
export const INHERIT = 'inherit'
export type ProjectChoice = GuardAction | typeof INHERIT

/** Built-in rules grouped by category, in the order the main process lists them. */
export function rulesByCategory(
  rules: readonly GuardRuleInfo[]
): Map<GuardCategoryId, GuardRuleInfo[]> {
  const groups = new Map<GuardCategoryId, GuardRuleInfo[]>()
  for (const rule of rules) {
    const list = groups.get(rule.category)
    if (list) list.push(rule)
    else groups.set(rule.category, [rule])
  }
  return groups
}

/** Rule overrides after choosing `choice` for `ruleId`; following the category drops it. */
export function withRuleChoice(
  overrides: Readonly<Record<string, GuardAction>>,
  ruleId: string,
  choice: RuleChoice
): Record<string, GuardAction> {
  const next = { ...overrides }
  if (choice === FOLLOW_CATEGORY) delete next[ruleId]
  else next[ruleId] = choice
  return next
}

/** Project category actions after a choice; inheriting drops the category. */
export function withProjectChoice(
  categories: ProjectGuard['categories'],
  category: GuardCategoryId,
  choice: ProjectChoice
): ProjectGuard['categories'] {
  const next = { ...categories }
  if (choice === INHERIT) delete next[category]
  else next[category] = choice
  return next
}

/** Allowing everything in these categories is confirmed first. */
export const needsAllowConfirm = (category: GuardCategoryId, action: RuleChoice): boolean =>
  action === 'allow' && GUARD_CONFIRM_ALLOW.includes(category)

/**
 * What a rule does while it follows its category, mirroring the main process: a rule with a
 * default deny keeps it unless the category allows, and a capped rule asks at most.
 */
export function followedRuleAction(
  rule: GuardRuleInfo,
  categoryAction: GuardAction
): { action: GuardAction; source: 'category' | 'default' | 'capped' } {
  if (categoryAction !== 'allow' && rule.defaultAction) {
    return { action: rule.defaultAction, source: 'default' }
  }
  if (categoryAction === 'deny' && rule.maxAction === 'ask')
    return { action: 'ask', source: 'capped' }
  return { action: categoryAction, source: 'category' }
}

/** Whether `action` can be chosen for the rule; capped rules cannot be set to deny. */
export const ruleActionAvailable = (rule: GuardRuleInfo, action: GuardAction): boolean =>
  !(rule.maxAction === 'ask' && action === 'deny')

/**
 * The guard is on but the hook cannot run: everywhere (managed hooks only) or in the given
 * project (its settings disable all hooks). Without a project, any project counts.
 */
export function guardHooksOff(status: TestQueueHookStatus | null, projectId?: string): boolean {
  if (!status?.guardEnabled) return false
  if (status.managedHooksOnly) return true
  return projectId === undefined
    ? status.hooksDisabledProjectIds.length > 0
    : status.hooksDisabledProjectIds.includes(projectId)
}

/** The guard is on but ClaudeDeck's hook server is not running: tool calls in tabs are denied. */
export const guardServerDown = (status: TestQueueHookStatus | null): boolean =>
  !!status?.guardEnabled && !!status.guardUnavailable

/**
 * Locale keys describing a log entry that is not a tool call decision (a tamper or project
 * config notice), most general first; empty for decisions.
 */
export function guardEventKeys(entry: Pick<GuardLogEntry, 'kind' | 'hooksDisabled'>): string[] {
  if (entry.kind === 'tamper') return ['guard.event.tamper']
  if (entry.kind !== 'projectConfig') return []
  return entry.hooksDisabled
    ? ['guard.event.projectConfig', 'guard.event.hooksDisabled']
    : ['guard.event.projectConfig']
}

/** Rules in a category with their own action, for the collapsed row's counter. */
export const overrideCount = (
  rules: readonly GuardRuleInfo[],
  overrides: Readonly<Record<string, GuardAction>>
): number => rules.filter((rule) => overrides[rule.id] !== undefined).length

/** The category action a project uses: its own or the global one. */
export const projectCategoryAction = (
  global: GuardSettings,
  project: ProjectGuard | undefined,
  category: GuardCategoryId
): GuardAction => project?.categories[category] ?? global.categories[category]

/** A new live entry on top of the loaded log, keeping the newest `GUARD_LIMITS.logSize`. */
export function prependLogEntry(
  log: readonly GuardLogEntry[],
  entry: GuardLogEntry
): GuardLogEntry[] {
  if (log.some((e) => e.id === entry.id)) return [...log]
  return [entry, ...log].slice(0, GUARD_LIMITS.logSize)
}

/** Single line text of at most `max` characters, with an ellipsis when cut. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Deny notices within one burst merge into a single toast. A burst lasts while the toast is
 * shown (each merge restarts its timer) and at most `BURST_MS` after it started, so a long run
 * of denials still produces a fresh toast now and then.
 */
export const DENY_BURST_MS = 30_000

export interface DenyBurst {
  startedAt: number
  count: number
}

export function nextDenyBurst(previous: DenyBurst | null, now: number): DenyBurst {
  if (previous && now - previous.startedAt < DENY_BURST_MS) {
    return { startedAt: previous.startedAt, count: previous.count + 1 }
  }
  return { startedAt: now, count: 1 }
}

export type GuardPatternCheck =
  { ok: true } | { ok: false; reason: 'empty' | 'tooLong' | 'regex' | 'unsafe'; detail?: string }

/**
 * A custom rule pattern as the main process will judge it: like a test queue rule, and a regex
 * must not be able to backtrack catastrophically.
 */
export function checkGuardPattern(kind: 'prefix' | 'regex', pattern: string): GuardPatternCheck {
  const check = checkPattern(kind, pattern, GUARD_LIMITS.maxPatternLength)
  if (!check.ok) return check
  if (kind === 'regex' && !isSafeRegex(pattern.trim())) return { ok: false, reason: 'unsafe' }
  return { ok: true }
}
