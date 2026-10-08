import type { GuardAction, GuardCategoryId } from './types'

/** Built-in categories in display order, with their default action. */
export const GUARD_CATEGORIES: readonly { id: GuardCategoryId; defaultAction: GuardAction }[] = [
  { id: 'disk', defaultAction: 'deny' },
  { id: 'sensitive', defaultAction: 'deny' },
  { id: 'git', defaultAction: 'ask' },
  { id: 'fetchExec', defaultAction: 'ask' },
  { id: 'docker', defaultAction: 'ask' },
  { id: 'database', defaultAction: 'ask' },
  { id: 'publish', defaultAction: 'ask' },
  { id: 'system', defaultAction: 'ask' }
]

export const GUARD_CATEGORY_IDS: readonly GuardCategoryId[] = GUARD_CATEGORIES.map((c) => c.id)

/** Categories whose switch to `allow` the UI confirms first. */
export const GUARD_CONFIRM_ALLOW: readonly GuardCategoryId[] = ['disk', 'sensitive']

export const GUARD_ACTIONS: readonly GuardAction[] = ['allow', 'ask', 'deny']

export const GUARD_LIMITS = {
  /** Custom rules per list (global or per project). */
  maxCustomRules: 100,
  maxPatternLength: 300,
  /** Rule overrides per list. */
  maxRuleOverrides: 200,
  /** Activity log entries kept in memory. */
  logSize: 200,
  /** Longest input "try a command" accepts. */
  maxEvaluateInput: 64 * 1024
} as const

/** Custom rule ids and built-in rule ids (`git.forcePush`). */
export const GUARD_RULE_ID = /^[A-Za-z0-9_.:-]{1,64}$/

export const isGuardAction = (value: unknown): value is GuardAction =>
  value === 'allow' || value === 'ask' || value === 'deny'

export const isGuardCategory = (value: unknown): value is GuardCategoryId =>
  typeof value === 'string' && (GUARD_CATEGORY_IDS as readonly string[]).includes(value)
