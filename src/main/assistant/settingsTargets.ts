import { GUARD_CONFIRM_ALLOW } from '../../shared/guardLimits'
import { BYPASS_MODE } from '../../shared/permissionMode'
import type {
  AssistantConfirmation,
  AssistantDiff,
  AssistantRisk,
  AssistantRuleItem,
  AssistantScope,
  AssistantSection,
  AssistantValue
} from '../../shared/assistant'
import type {
  AppState,
  GuardAction,
  GuardCategoryId,
  GuardRuleInfo,
  Language,
  ProjectGuard,
  ProjectTestQueue
} from '../../shared/types'
import { JsonStore } from '../state/jsonStore'
import { Repository } from '../state/repository'
import { defaultProjectTestQueue } from '../state/testQueueSettings'
import type { SetterCall } from './settingsSpec'

/**
 * The settings a change touches (a "target": one section, globally or for one project): its
 * current value, the diff between two states, the setter that writes it and how to put the old
 * value back for undo.
 */

export interface Target {
  section: AssistantSection
  scope: AssistantScope
  projectId?: string
}

type Json = Record<string, unknown>

const sameTarget = (a: Target, b: Target): boolean =>
  a.section === b.section && a.scope === b.scope && a.projectId === b.projectId

/** Distinct targets, in first-seen order. */
export function uniqueTargets<T extends Target>(targets: readonly T[]): Target[] {
  const out: Target[] = []
  for (const t of targets) {
    if (!out.some((o) => sameTarget(o, t))) {
      out.push(
        t.projectId === undefined
          ? { section: t.section, scope: t.scope }
          : { section: t.section, scope: t.scope, projectId: t.projectId }
      )
    }
  }
  return out
}

const emptyProjectGuard = (): ProjectGuard => ({
  categories: {},
  ruleOverrides: {},
  customRules: []
})

/** The target's value in `state`, with project defaults filled in; undefined: project gone. */
export function targetValue(state: AppState, target: Target): Json | undefined {
  const s = state.settings
  if (target.scope === 'project') {
    const project = state.projects.find((p) => p.id === target.projectId)
    if (!project) return undefined
    switch (target.section) {
      case 'guard':
        return { ...emptyProjectGuard(), ...project.guard } as unknown as Json
      case 'testQueue':
        return { ...defaultProjectTestQueue(), ...project.testQueue } as unknown as Json
      case 'claude':
        return { permissionMode: project.claude?.permissionMode ?? null }
      default:
        return undefined
    }
  }
  switch (target.section) {
    case 'guard':
      return s.guard as unknown as Json
    case 'testQueue':
      return s.testQueue as unknown as Json
    case 'claude':
      return s.claude as unknown as Json
    case 'usage':
      return s.usage as unknown as Json
    case 'general':
      return { language: s.language, launchAtLogin: s.launchAtLogin }
  }
}

const RULE_LISTS = new Set(['customRules', 'customPatterns'])

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const scalar = (v: unknown): AssistantValue =>
  v === undefined
    ? null
    : typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : (v as AssistantValue)

function ruleItem(raw: Json): AssistantRuleItem {
  const item: AssistantRuleItem = {
    kind: raw.kind as 'prefix' | 'regex',
    pattern: String(raw.pattern)
  }
  if (raw.kind === 'regex' && raw.target) item.target = raw.target as 'canonical' | 'raw'
  if (raw.action) item.action = raw.action as GuardAction
  return item
}

const ruleKey = (r: AssistantRuleItem): string =>
  JSON.stringify([r.kind, r.pattern, r.target ?? null, r.action ?? null])

/** What differs between two values of one target, as the user reads it. */
export function diffValues(before: Json, after: Json, prefix = ''): AssistantDiff[] {
  const diffs: AssistantDiff[] = []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  for (const key of keys) {
    const field = `${prefix}${key}`
    const a = before[key]
    const b = after[key]
    if (RULE_LISTS.has(key) && (Array.isArray(a) || Array.isArray(b))) {
      const from = ((a as Json[]) ?? []).map(ruleItem)
      const to = ((b as Json[]) ?? []).map(ruleItem)
      const fromKeys = new Set(from.map(ruleKey))
      const toKeys = new Set(to.map(ruleKey))
      const list = key as 'customRules' | 'customPatterns'
      for (const r of from)
        if (!toKeys.has(ruleKey(r))) diffs.push({ kind: 'ruleRemoved', field: list, rule: r })
      for (const r of to)
        if (!fromKeys.has(ruleKey(r))) diffs.push({ kind: 'ruleAdded', field: list, rule: r })
      continue
    }
    if (key === 'disabledBuiltins' && (Array.isArray(a) || Array.isArray(b))) {
      const from = new Set((a as string[]) ?? [])
      const to = new Set((b as string[]) ?? [])
      for (const id of to) if (!from.has(id)) diffs.push({ kind: 'builtinOff', id })
      for (const id of from) if (!to.has(id)) diffs.push({ kind: 'builtinOn', id })
      continue
    }
    if (isObject(a) || isObject(b)) {
      diffs.push(...diffValues(isObject(a) ? a : {}, isObject(b) ? b : {}, `${field}.`))
      continue
    }
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      diffs.push({ kind: 'set', field, from: scalar(a), to: scalar(b) })
    }
  }
  return diffs
}

const SEVERITY: Record<GuardAction, number> = { allow: 0, ask: 1, deny: 2 }

/** Guard action a category or rule falls to when the value is null (inherit, follow). */
function effectiveRuleAction(
  rules: readonly GuardRuleInfo[],
  ruleId: string,
  categories: Readonly<Record<string, GuardAction>>
): { category: GuardCategoryId; action: GuardAction } | null {
  const rule = rules.find((r) => r.id === ruleId)
  if (!rule) return null
  return { category: rule.category, action: categories[rule.category] ?? 'ask' }
}

/**
 * Risk notes and the confirmations manual edits ask for (Disk ve sistem or Hassas dosyalar to
 * allow, bypass permissions). `before` and `after` are whole states; only `targets` are looked at.
 */
export function assessRisks(
  before: AppState,
  after: AppState,
  targets: readonly Target[],
  rules: readonly GuardRuleInfo[]
): { risks: AssistantRisk[]; confirmations: AssistantConfirmation[] } {
  const risks: AssistantRisk[] = []
  const confirmations = new Set<AssistantConfirmation>()
  const addRisk = (risk: AssistantRisk): void => {
    if (!risks.some((r) => JSON.stringify(r) === JSON.stringify(risk))) risks.push(risk)
  }
  const relaxed = (
    category: GuardCategoryId | 'custom',
    from: GuardAction | undefined,
    to: GuardAction
  ): void => {
    if (from !== undefined && SEVERITY[to] >= SEVERITY[from]) return
    if (to === 'allow' && category !== 'custom' && GUARD_CONFIRM_ALLOW.includes(category)) {
      confirmations.add(`guardAllow:${category}`)
      addRisk({ kind: 'guardAllow', category })
    } else {
      addRisk({ kind: 'guardRelaxed', category, to })
    }
  }

  for (const target of targets) {
    const a = targetValue(before, target)
    const b = targetValue(after, target)
    if (!a || !b) continue
    if (target.section === 'guard') {
      const globalCats = before.settings.guard.categories
      if (a.enabled === true && b.enabled === false) addRisk({ kind: 'guardOff' })
      const catsA = a.categories as Record<string, GuardAction>
      const catsB = b.categories as Record<string, GuardAction>
      for (const [id, action] of Object.entries(catsB)) {
        if (catsA[id] === action) continue
        const was = catsA[id] ?? globalCats[id as GuardCategoryId]
        relaxed(id as GuardCategoryId, was, action)
      }
      const overA = a.ruleOverrides as Record<string, GuardAction>
      const overB = b.ruleOverrides as Record<string, GuardAction>
      for (const [id, action] of Object.entries(overB)) {
        if (overA[id] === action) continue
        const rule = effectiveRuleAction(rules, id, { ...globalCats, ...catsA })
        if (rule) relaxed(rule.category, overA[id] ?? rule.action, action)
      }
      const customA = new Set(((a.customRules as Json[]) ?? []).map((r) => ruleKey(ruleItem(r))))
      for (const raw of (b.customRules as Json[]) ?? []) {
        const item = ruleItem(raw)
        if (!customA.has(ruleKey(item)) && item.action === 'allow')
          relaxed('custom', undefined, 'allow')
      }
    }
    if (target.section === 'testQueue' && a.enabled === true && b.enabled === false) {
      addRisk({ kind: 'testQueueOff' })
    }
    if (target.section === 'claude') {
      const toBypass = b.permissionMode === BYPASS_MODE && a.permissionMode !== BYPASS_MODE
      const allowOn = b.allowBypass === true && a.allowBypass !== true
      if (toBypass || allowOn) {
        confirmations.add('bypass')
        addRisk({ kind: 'bypass' })
      }
    }
  }
  return { risks, confirmations: [...confirmations] }
}

/** `data-setting` keys of the rows a change touches in the settings view (global only). */
export function changedKeys(
  section: AssistantSection,
  diffs: readonly AssistantDiff[],
  rules: readonly GuardRuleInfo[]
): string[] {
  const keys = new Set<string>()
  for (const diff of diffs) {
    if (diff.kind === 'builtinOff' || diff.kind === 'builtinOn') {
      keys.add(`${section}.disabledBuiltins`)
      continue
    }
    if (diff.kind !== 'set') {
      keys.add(`${section}.${diff.field}`)
      continue
    }
    const [root, ...rest] = diff.field.split('.')
    if (section === 'guard' && root === 'categories') keys.add(`guard.categories.${rest[0]}`)
    else if (section === 'guard' && root === 'ruleOverrides') {
      const rule = rules.find((r) => r.id === rest.join('.'))
      if (rule) keys.add(`guard.categories.${rule.category}`)
    } else if (root === 'auto') keys.add(`${section}.${diff.field}`)
    else keys.add(`${section}.${root}`)
  }
  return [...keys]
}

/* -------------------------------------------------------------------------------------------- */

/** Writes a validated setter call through the repository (the same setters as manual edits). */
export function applySetter(repo: Repository, call: SetterCall): AppState {
  const p = call.patch
  if (call.scope === 'project') {
    const id = call.projectId as string
    switch (call.section) {
      case 'guard':
        return repo.setProjectGuard(id, p as Partial<ProjectGuard>)
      case 'testQueue':
        return repo.setProjectTestQueue(id, p as Partial<ProjectTestQueue>)
      case 'claude':
        return repo.setProjectClaude(id, p)
      default:
        throw new Error(`no project settings for ${call.section}`)
    }
  }
  switch (call.section) {
    case 'guard':
      return repo.setGuardSettings(p)
    case 'testQueue':
      return repo.setTestQueueSettings(p)
    case 'claude':
      return repo.setClaudeSettings(p)
    case 'usage':
      return repo.setUsageSettings(p)
    case 'general': {
      let state = repo.get()
      if ('language' in p) state = repo.setLanguage(p.language as Language | null)
      if ('launchAtLogin' in p) state = repo.setLaunchAtLogin(p.launchAtLogin === true)
      return state
    }
  }
}

/**
 * The setter call that puts a saved target value back (undo). Null when there is nothing to
 * restore (the project was removed).
 */
export function restoreCall(
  target: Target,
  value: Json | undefined,
  state: AppState
): SetterCall | null {
  if (!value) return null
  if (target.scope === 'project' && !state.projects.some((p) => p.id === target.projectId))
    return null
  if (target.section === 'claude' && target.scope === 'project') {
    return { ...target, patch: { permissionMode: value.permissionMode ?? 'inherit' } }
  }
  if (target.section === 'usage') {
    const account = value.trayAccount as string
    const known =
      account === 'auto' || account === 'selected' || state.accounts.some((a) => a.id === account)
    return { ...target, patch: { ...value, trayAccount: known ? account : 'auto' } }
  }
  return { ...target, patch: { ...value } }
}

/** A repository over a copy of `state` that never touches the disk (dry runs). */
class MemoryStore extends JsonStore<AppState> {
  constructor(private data: AppState) {
    super('', () => data)
  }

  override load(): AppState {
    return structuredClone(this.data)
  }

  override save(data: AppState): void {
    this.data = data
  }
}

export const scratchRepository = (state: AppState): Repository =>
  new Repository(
    new MemoryStore(state),
    '/',
    () => `assistant-${Math.random().toString(36).slice(2, 10)}`
  )
