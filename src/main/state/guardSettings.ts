import { DomainError } from '../../shared/errors'
import {
  GUARD_CATEGORIES,
  GUARD_LIMITS as LIMITS,
  GUARD_RULE_ID,
  isGuardAction,
  isGuardCategory
} from '../../shared/guardLimits'
import { isSafeRegex } from '../../shared/safeRegex'
import type {
  GuardAction,
  GuardCategoryId,
  GuardCustomRule,
  GuardSettings,
  GuardSettingsPatch,
  ProjectGuard
} from '../../shared/types'

export const defaultGuardCategories = (): Record<GuardCategoryId, GuardAction> =>
  Object.fromEntries(GUARD_CATEGORIES.map((c) => [c.id, c.defaultAction])) as Record<
    GuardCategoryId,
    GuardAction
  >

export const defaultGuardSettings = (): GuardSettings => ({
  enabled: true,
  categories: defaultGuardCategories(),
  ruleOverrides: {},
  customRules: []
})

export const emptyProjectGuard = (): ProjectGuard => ({
  categories: {},
  ruleOverrides: {},
  customRules: []
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Category actions; unknown categories and actions are refused (patch) or dropped (load). */
function categories(
  value: unknown,
  strict: boolean
): Partial<Record<GuardCategoryId, GuardAction>> {
  if (!isObject(value)) {
    if (strict) throw new DomainError('INVALID')
    return {}
  }
  const out: Partial<Record<GuardCategoryId, GuardAction>> = {}
  for (const [id, action] of Object.entries(value)) {
    if (isGuardCategory(id) && isGuardAction(action)) out[id] = action
    else if (strict) throw new DomainError('INVALID')
  }
  return out
}

/** Rule id to action; any well-formed id is kept so overrides survive rule renames in the UI. */
function ruleOverrides(value: unknown, strict: boolean): Record<string, GuardAction> {
  if (!isObject(value)) {
    if (strict) throw new DomainError('INVALID')
    return {}
  }
  const entries = Object.entries(value)
  if (strict && entries.length > LIMITS.maxRuleOverrides) throw new DomainError('INVALID')
  const out: Record<string, GuardAction> = {}
  for (const [id, action] of entries.slice(0, LIMITS.maxRuleOverrides)) {
    if (GUARD_RULE_ID.test(id) && isGuardAction(action)) out[id] = action
    else if (strict) throw new DomainError('INVALID')
  }
  return out
}

/** One custom rule, validated like a test queue rule plus its action. Throws INVALID. */
function cleanRule(raw: unknown, id: string): GuardCustomRule {
  if (!isObject(raw)) throw new DomainError('INVALID')
  const { kind, pattern, target, action } = raw
  if (kind !== 'prefix' && kind !== 'regex') throw new DomainError('INVALID')
  if (typeof pattern !== 'string') throw new DomainError('INVALID')
  if (!isGuardAction(action)) throw new DomainError('INVALID')
  const text = pattern.trim()
  if (!text || text.length > LIMITS.maxPatternLength) throw new DomainError('INVALID')
  if (kind === 'prefix') return { id, kind, pattern: text, action }
  try {
    new RegExp(text)
  } catch {
    throw new DomainError('INVALID')
  }
  if (!isSafeRegex(text)) throw new DomainError('INVALID')
  if (target !== undefined && target !== 'canonical' && target !== 'raw') {
    throw new DomainError('INVALID')
  }
  return { id, kind, pattern: text, target: target ?? 'canonical', action }
}

/** Validates custom rules (patch): keeps valid unique ids, generates the rest. */
export function cleanGuardRules(value: unknown, newId: () => string): GuardCustomRule[] {
  if (!Array.isArray(value) || value.length > LIMITS.maxCustomRules) {
    throw new DomainError('INVALID')
  }
  const seen = new Set<string>()
  return value.map((raw: unknown) => {
    let id = isObject(raw) && typeof raw.id === 'string' && GUARD_RULE_ID.test(raw.id) ? raw.id : ''
    if (!id || seen.has(id)) id = newId()
    seen.add(id)
    return cleanRule(raw, id)
  })
}

/** Saved rules that still pass validation; the others are dropped one by one. */
function loadedRules(value: unknown): GuardCustomRule[] {
  if (!Array.isArray(value)) return []
  const kept: GuardCustomRule[] = []
  const ids = new Set<string>()
  let n = 0
  for (const raw of value.slice(0, LIMITS.maxCustomRules)) {
    try {
      let id =
        isObject(raw) && typeof raw.id === 'string' && GUARD_RULE_ID.test(raw.id) ? raw.id : ''
      if (!id || ids.has(id)) id = `loaded-${++n}`
      ids.add(id)
      kept.push(cleanRule(raw, id))
    } catch {
      // Refused today: left out.
    }
  }
  return kept
}

/**
 * Saved guard settings as the evaluator may use them. A config file written before the guard
 * existed gets the defaults (guard on); hand-edited values that a patch would refuse are dropped.
 */
export function withGuardDefaults(saved: unknown): GuardSettings {
  const defaults = defaultGuardSettings()
  if (!isObject(saved)) return defaults
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    categories: { ...defaults.categories, ...categories(saved.categories, false) },
    ruleOverrides: ruleOverrides(saved.ruleOverrides, false),
    customRules: loadedRules(saved.customRules)
  }
}

/** Saved project overrides; undefined when nothing is left. */
export function withProjectGuardDefaults(saved: unknown): ProjectGuard | undefined {
  if (!isObject(saved)) return undefined
  const next: ProjectGuard = {
    categories: categories(saved.categories, false),
    ruleOverrides: ruleOverrides(saved.ruleOverrides, false),
    customRules: loadedRules(saved.customRules)
  }
  return isEmptyProjectGuard(next) ? undefined : next
}

const isEmptyProjectGuard = (g: ProjectGuard): boolean =>
  !Object.keys(g.categories).length && !Object.keys(g.ruleOverrides).length && !g.customRules.length

/** Applies a settings patch with validation (INVALID). Categories merge; the rest replaces. */
export function applyGuardPatch(
  current: GuardSettings,
  patch: GuardSettingsPatch,
  newId: () => string
): GuardSettings {
  if (!isObject(patch)) throw new DomainError('INVALID')
  const next: GuardSettings = { ...current }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new DomainError('INVALID')
    next.enabled = patch.enabled
  }
  if (patch.categories !== undefined) {
    next.categories = { ...current.categories, ...categories(patch.categories, true) }
  }
  if (patch.ruleOverrides !== undefined) {
    next.ruleOverrides = ruleOverrides(patch.ruleOverrides, true)
  }
  if (patch.customRules !== undefined) {
    next.customRules = cleanGuardRules(patch.customRules, newId)
  }
  return next
}

/**
 * Applies a project override patch; fields given replace the stored ones (so a category can be
 * set back to inherit by leaving it out). Returns null when nothing is overridden any more.
 */
export function applyProjectGuardPatch(
  current: ProjectGuard | undefined,
  patch: Partial<ProjectGuard> | null,
  newId: () => string
): ProjectGuard | null {
  if (patch === null) return null
  if (!isObject(patch)) throw new DomainError('INVALID')
  const next: ProjectGuard = { ...(current ?? emptyProjectGuard()) }
  if (patch.categories !== undefined) next.categories = categories(patch.categories, true)
  if (patch.ruleOverrides !== undefined) {
    next.ruleOverrides = ruleOverrides(patch.ruleOverrides, true)
  }
  if (patch.customRules !== undefined) {
    next.customRules = cleanGuardRules(patch.customRules, newId)
  }
  return isEmptyProjectGuard(next) ? null : next
}
