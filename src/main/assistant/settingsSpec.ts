import { GUARD_ACTIONS, GUARD_CATEGORY_IDS, GUARD_LIMITS } from '../../shared/guardLimits'
import { LANGUAGES } from '../../shared/language'
import { PERMISSION_MODES } from '../../shared/permissionMode'
import { isSafeRegex } from '../../shared/safeRegex'
import { TEST_QUEUE_LIMITS } from '../../shared/testQueueLimits'
import { createTranslator } from '../../shared/translate'
import type { AssistantChangeInput, AssistantScope, AssistantSection } from '../../shared/assistant'
import type {
  AppState,
  GuardCustomRule,
  GuardRuleInfo,
  Project,
  TestPattern,
  TestQueueBuiltin
} from '../../shared/types'

/**
 * What the settings assistant may change, described for Claude (overview and schema) and
 * checked with precise messages before the repository setters (the same normalisers as manual
 * edits) get the result. Model-friendly patch shapes are expanded into setter patches here:
 * lists accept `{ add, remove }`, maps merge with null removing an entry.
 */

/** Built-in rule and pattern lists the schema names and patches are checked against. */
export interface AssistantCatalog {
  guardRules: GuardRuleInfo[]
  testBuiltins: TestQueueBuiltin[]
}

/** A patch Claude can fix: the message names the field and what is allowed. */
export class AssistantValidationError extends Error {}

/** A validated change in the shape the repository setter takes. */
export interface SetterCall {
  section: AssistantSection
  scope: AssistantScope
  projectId?: string
  patch: Record<string, unknown>
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const fail = (path: string, message: string): never => {
  throw new AssistantValidationError(`${path}: ${message}`)
}

const list = (values: readonly unknown[]): string => values.map((v) => JSON.stringify(v)).join(', ')

function oneOf<T>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) fail(path, `must be one of ${list(allowed)}`)
  return value as T
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be true or false')
  return value as boolean
}

function int(value: unknown, range: { min: number; max: number }, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be a whole number')
  const n = value as number
  if (n < range.min || n > range.max) fail(path, `must be between ${range.min} and ${range.max}`)
  return n
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) fail(path, 'must be an object')
  return value as Json
}

function onlyKeys(value: Json, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `unknown field; allowed: ${list(allowed)}`)
  }
}

/** Pattern rules as the setters judge them, with the reason when one is refused. */
function cleanPattern(raw: unknown, path: string, withAction: boolean): Json {
  const rule = object(raw, path)
  onlyKeys(
    rule,
    withAction
      ? ['id', 'kind', 'pattern', 'target', 'action']
      : ['id', 'kind', 'pattern', 'target'],
    path
  )
  const kind = oneOf(rule.kind, ['prefix', 'regex'] as const, `${path}.kind`)
  if (typeof rule.pattern !== 'string') fail(`${path}.pattern`, 'must be a string')
  const pattern = (rule.pattern as string).trim()
  if (!pattern) fail(`${path}.pattern`, 'must not be empty')
  const max = withAction ? GUARD_LIMITS.maxPatternLength : TEST_QUEUE_LIMITS.maxPatternLength
  if (pattern.length > max) fail(`${path}.pattern`, `at most ${max} characters`)
  const out: Json = { kind, pattern }
  if (typeof rule.id === 'string') out.id = rule.id
  if (kind === 'regex') {
    try {
      new RegExp(pattern)
    } catch (error) {
      fail(`${path}.pattern`, `not a valid JavaScript regex (${(error as Error).message})`)
    }
    if (!isSafeRegex(pattern)) {
      fail(
        `${path}.pattern`,
        'regex could backtrack catastrophically; avoid backreferences and nested or ' +
          'alternating repetition (for example (a+)+ or (a|ab)*)'
      )
    }
    out.target =
      rule.target === undefined
        ? 'canonical'
        : oneOf(rule.target, ['canonical', 'raw'] as const, `${path}.target`)
  } else if (rule.target !== undefined) {
    fail(`${path}.target`, 'only regex rules take a target')
  }
  if (withAction) out.action = oneOf(rule.action, GUARD_ACTIONS, `${path}.action`)
  return out
}

/** A list field: a full array replaces it, `{ add, remove }` edits the current one. */
function editList<T extends { id: string }>(
  value: unknown,
  current: readonly T[],
  max: number,
  path: string,
  clean: (raw: unknown, path: string) => Json
): Json[] {
  if (Array.isArray(value)) {
    if (value.length > max) fail(path, `at most ${max} rules`)
    return value.map((raw, i) => clean(raw, `${path}[${i}]`))
  }
  const edit = object(value, path)
  onlyKeys(edit, ['add', 'remove'], path)
  const remove = edit.remove === undefined ? [] : edit.remove
  if (!Array.isArray(remove)) fail(`${path}.remove`, 'must be an array of rule ids')
  const ids = new Set(current.map((r) => r.id))
  for (const [i, id] of (remove as unknown[]).entries()) {
    if (typeof id !== 'string' || !ids.has(id)) {
      fail(`${path}.remove[${i}]`, `unknown rule id; current ids: ${list([...ids]) || 'none'}`)
    }
  }
  const add = edit.add === undefined ? [] : edit.add
  if (!Array.isArray(add)) fail(`${path}.add`, 'must be an array of rules')
  const removed = new Set(remove as string[])
  const next: Json[] = [
    ...current.filter((r) => !removed.has(r.id)).map((r) => ({ ...r }) as Json),
    ...(add as unknown[]).map((raw, i) => {
      const rule = clean(raw, `${path}.add[${i}]`)
      delete rule.id
      return rule
    })
  ]
  if (next.length > max) fail(path, `at most ${max} rules in total`)
  return next
}

/** Built-in pattern ids: a full array replaces, `{ add, remove }` edits the current list. */
function editIds(
  value: unknown,
  current: readonly string[],
  known: Set<string>,
  path: string
): string[] {
  const check = (ids: unknown, at: string): string[] => {
    if (!Array.isArray(ids)) fail(at, 'must be an array of built-in ids')
    for (const [i, id] of (ids as unknown[]).entries()) {
      if (typeof id !== 'string' || !known.has(id)) {
        fail(`${at}[${i}]`, 'unknown built-in id; see get_section_schema("testQueue")')
      }
    }
    return ids as string[]
  }
  if (Array.isArray(value)) return [...new Set(check(value, path))]
  const edit = object(value, path)
  onlyKeys(edit, ['add', 'remove'], path)
  const add = edit.add === undefined ? [] : check(edit.add, `${path}.add`)
  const remove = new Set(edit.remove === undefined ? [] : check(edit.remove, `${path}.remove`))
  const next = [...new Set([...current, ...add])].filter((id) => !remove.has(id))
  if (next.length > TEST_QUEUE_LIMITS.maxDisabledBuiltins) fail(path, 'too many ids')
  return next
}

/** A map merged into `current`; null (or `inheritValue`) removes an entry. */
function mergeMap(
  value: unknown,
  current: Readonly<Record<string, string>>,
  keys: readonly string[],
  values: readonly string[],
  path: string,
  keyHint: string,
  inheritValue?: string
): Record<string, string> {
  const patch = object(value, path)
  const next: Record<string, string> = { ...current }
  for (const [key, action] of Object.entries(patch)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, `unknown ${keyHint}`)
    if (action === null || (inheritValue !== undefined && action === inheritValue)) {
      delete next[key]
      continue
    }
    next[key] = oneOf(action, values, `${path}.${key}`)
  }
  return next
}

function guardPatch(
  patch: Json,
  scope: AssistantScope,
  current: {
    categories: Record<string, string>
    ruleOverrides: Record<string, string>
    customRules: GuardCustomRule[]
  },
  catalog: AssistantCatalog,
  path: string
): Json {
  const ruleIds = catalog.guardRules.map((r) => r.id)
  const project = scope === 'project'
  onlyKeys(
    patch,
    project
      ? ['categories', 'ruleOverrides', 'customRules']
      : ['enabled', 'categories', 'ruleOverrides', 'customRules'],
    path
  )
  const out: Json = {}
  if (patch.enabled !== undefined) out.enabled = bool(patch.enabled, `${path}.enabled`)
  if (patch.categories !== undefined) {
    out.categories = project
      ? mergeMap(
          patch.categories,
          current.categories,
          GUARD_CATEGORY_IDS,
          GUARD_ACTIONS,
          `${path}.categories`,
          'category',
          'inherit'
        )
      : (() => {
          const value = object(patch.categories, `${path}.categories`)
          const next: Record<string, string> = {}
          for (const [id, action] of Object.entries(value)) {
            if (!GUARD_CATEGORY_IDS.includes(id as never))
              fail(`${path}.categories.${id}`, 'unknown category')
            next[id] = oneOf(action, GUARD_ACTIONS, `${path}.categories.${id}`)
          }
          return next
        })()
  }
  if (patch.ruleOverrides !== undefined) {
    const next = mergeMap(
      patch.ruleOverrides,
      current.ruleOverrides,
      ruleIds,
      GUARD_ACTIONS,
      `${path}.ruleOverrides`,
      'built-in rule id; see get_section_schema("guard")',
      'category'
    )
    if (Object.keys(next).length > GUARD_LIMITS.maxRuleOverrides)
      fail(`${path}.ruleOverrides`, 'too many overrides')
    out.ruleOverrides = next
  }
  if (patch.customRules !== undefined) {
    out.customRules = editList(
      patch.customRules,
      current.customRules,
      GUARD_LIMITS.maxCustomRules,
      `${path}.customRules`,
      (raw, at) => cleanPattern(raw, at, true)
    )
  }
  return out
}

function testQueuePatch(
  patch: Json,
  scope: AssistantScope,
  current: { disabledBuiltins: string[]; customPatterns: TestPattern[] },
  catalog: AssistantCatalog,
  path: string
): Json {
  const L = TEST_QUEUE_LIMITS
  const known = new Set(catalog.testBuiltins.map((b) => b.id))
  const project = scope === 'project'
  const listKeys = ['disabledBuiltins', 'customPatterns']
  onlyKeys(
    patch,
    project
      ? ['mode', ...listKeys]
      : [
          'enabled',
          'mode',
          'maxConcurrent',
          'auto',
          'maxWaitMinutes',
          'startGraceSeconds',
          'backgroundMaxHoldMinutes',
          ...listKeys
        ],
    path
  )
  const out: Json = {}
  if (patch.enabled !== undefined) out.enabled = bool(patch.enabled, `${path}.enabled`)
  if (patch.mode !== undefined) {
    out.mode = oneOf(
      patch.mode,
      project ? (['inherit', 'off'] as const) : (['fixed', 'auto'] as const),
      `${path}.mode`
    )
  }
  if (patch.maxConcurrent !== undefined)
    out.maxConcurrent = int(patch.maxConcurrent, L.maxConcurrent, `${path}.maxConcurrent`)
  for (const key of ['maxWaitMinutes', 'startGraceSeconds', 'backgroundMaxHoldMinutes'] as const) {
    if (patch[key] !== undefined) out[key] = int(patch[key], L[key], `${path}.${key}`)
  }
  if (patch.auto !== undefined) {
    const auto = object(patch.auto, `${path}.auto`)
    const keys = [
      'maxConcurrent',
      'cpuHighPercent',
      'cpuResumePercent',
      'minAvailableMemoryPercent',
      'rampUpSeconds'
    ] as const
    onlyKeys(auto, keys, `${path}.auto`)
    const next: Json = {}
    if (auto.maxConcurrent !== undefined) {
      next.maxConcurrent =
        auto.maxConcurrent === null
          ? null
          : int(auto.maxConcurrent, L.autoMaxConcurrent, `${path}.auto.maxConcurrent`)
    }
    for (const key of keys.slice(1) as Exclude<(typeof keys)[number], 'maxConcurrent'>[]) {
      if (auto[key] !== undefined) next[key] = int(auto[key], L[key], `${path}.auto.${key}`)
    }
    out.auto = next
  }
  if (patch.disabledBuiltins !== undefined) {
    out.disabledBuiltins = editIds(
      patch.disabledBuiltins,
      current.disabledBuiltins,
      known,
      `${path}.disabledBuiltins`
    )
  }
  if (patch.customPatterns !== undefined) {
    out.customPatterns = editList(
      patch.customPatterns,
      current.customPatterns,
      L.maxPatterns,
      `${path}.customPatterns`,
      (raw, at) => cleanPattern(raw, at, false)
    )
  }
  return out
}

function claudePatch(patch: Json, scope: AssistantScope, path: string): Json {
  if (scope === 'project') {
    onlyKeys(patch, ['permissionMode'], path)
    return patch.permissionMode === undefined
      ? {}
      : {
          permissionMode: oneOf(
            patch.permissionMode,
            [...PERMISSION_MODES, 'inherit'],
            `${path}.permissionMode`
          )
        }
  }
  onlyKeys(patch, ['permissionMode', 'allowBypass'], path)
  const out: Json = {}
  if (patch.permissionMode !== undefined)
    out.permissionMode = oneOf(patch.permissionMode, PERMISSION_MODES, `${path}.permissionMode`)
  if (patch.allowBypass !== undefined)
    out.allowBypass = bool(patch.allowBypass, `${path}.allowBypass`)
  return out
}

function usagePatch(patch: Json, state: AppState, path: string): Json {
  onlyKeys(patch, ['display', 'trayEnabled', 'trayMetric', 'trayAccount'], path)
  const out: Json = {}
  if (patch.display !== undefined)
    out.display = oneOf(patch.display, ['used', 'remaining'] as const, `${path}.display`)
  if (patch.trayEnabled !== undefined)
    out.trayEnabled = bool(patch.trayEnabled, `${path}.trayEnabled`)
  if (patch.trayMetric !== undefined)
    out.trayMetric = oneOf(
      patch.trayMetric,
      ['session', 'weekly', 'both'] as const,
      `${path}.trayMetric`
    )
  if (patch.trayAccount !== undefined) {
    out.trayAccount = oneOf(
      patch.trayAccount,
      ['auto', 'selected', ...state.accounts.map((a) => a.id)],
      `${path}.trayAccount`
    )
  }
  return out
}

function generalPatch(patch: Json, path: string): Json {
  onlyKeys(patch, ['language', 'launchAtLogin'], path)
  const out: Json = {}
  if (patch.language !== undefined)
    out.language = oneOf(patch.language, [...LANGUAGES, null], `${path}.language`)
  if (patch.launchAtLogin !== undefined)
    out.launchAtLogin = bool(patch.launchAtLogin, `${path}.launchAtLogin`)
  return out
}

/** Sections that also have per-project overrides. */
const PROJECT_SECTIONS: readonly AssistantSection[] = ['guard', 'testQueue', 'claude']

/**
 * Checks one proposed change against the current state and turns it into the setter patch.
 * Throws AssistantValidationError with a message naming the field.
 */
export function expandChange(
  change: AssistantChangeInput,
  state: AppState,
  catalog: AssistantCatalog,
  path = 'change'
): SetterCall {
  const { section, scope } = change
  const patch = object(change.patch, `${path}.patch`)
  if (Object.keys(patch).length === 0) fail(`${path}.patch`, 'is empty; nothing would change')
  let project: Project | undefined
  if (scope === 'project') {
    if (!PROJECT_SECTIONS.includes(section))
      fail(`${path}.scope`, `"${section}" has no project settings; use "global"`)
    project = state.projects.find((p) => p.id === change.projectId)
    if (!project)
      fail(
        `${path}.projectId`,
        `unknown project; ids: ${list(state.projects.map((p) => p.id)) || 'none'}`
      )
  } else if (change.projectId !== undefined) {
    fail(`${path}.projectId`, 'only project changes take a projectId')
  }
  const at = `${path}.patch`
  const s = state.settings
  let out: Json
  switch (section) {
    case 'guard': {
      const current = project
        ? {
            categories: { ...project.guard?.categories },
            ruleOverrides: { ...project.guard?.ruleOverrides },
            customRules: project.guard?.customRules ?? []
          }
        : {
            categories: { ...s.guard.categories },
            ruleOverrides: { ...s.guard.ruleOverrides },
            customRules: s.guard.customRules
          }
      out = guardPatch(patch, scope, current as never, catalog, at)
      break
    }
    case 'testQueue': {
      const current = project
        ? {
            disabledBuiltins: project.testQueue?.disabledBuiltins ?? [],
            customPatterns: project.testQueue?.customPatterns ?? []
          }
        : s.testQueue
      out = testQueuePatch(patch, scope, current, catalog, at)
      break
    }
    case 'claude':
      out = claudePatch(patch, scope, at)
      break
    case 'usage':
      out = usagePatch(patch, state, at)
      break
    case 'general':
      out = generalPatch(patch, at)
      break
  }
  return project
    ? { section, scope, projectId: project.id, patch: out }
    : { section, scope, patch: out }
}

/* -------------------------------------------------------------------------------------------- */

const en = createTranslator('en')

/** Current values and what each section controls; no secrets, no paths. */
export function settingsOverview(state: AppState, catalog: AssistantCatalog): Json {
  const s = state.settings
  return {
    sections: {
      guard: {
        controls:
          'Command guard: checks every Bash/PowerShell command and file write of Claude tabs before it runs and allows, asks or denies it. Category actions, per built-in rule overrides, custom rules. Projects can override.',
        current: s.guard
      },
      testQueue: {
        controls:
          'Test queue: test commands of Claude tabs wait for a slot so parallel test runs do not overload the machine. Mode, limits, built-in patterns that count as tests, custom patterns. Projects can override.',
        current: s.testQueue
      },
      claude: {
        controls:
          'Starting permission mode of new Claude tabs and whether bypass permissions is reachable. Projects can override the mode.',
        current: s.claude
      },
      usage: {
        controls: 'Usage display (used or remaining) and the macOS menu bar item.',
        current: s.usage
      },
      general: {
        controls: 'Interface language (null follows the system) and opening ClaudeDeck at login.',
        current: { language: s.language, launchAtLogin: s.launchAtLogin }
      }
    },
    accounts: state.accounts.map((a) => ({ id: a.id, name: a.name })),
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      account: state.accounts.find((a) => a.id === p.accountId)?.name ?? null,
      overrides: {
        ...(p.guard ? { guard: p.guard } : {}),
        ...(p.testQueue ? { testQueue: p.testQueue } : {}),
        ...(p.claude?.permissionMode ? { claude: { permissionMode: p.claude.permissionMode } } : {})
      }
    })),
    guardRuleCount: catalog.guardRules.length,
    hint: 'Call get_section_schema(section) before proposing changes to a section.'
  }
}

const ruleShape = (withAction: boolean): Json => ({
  kind: '"prefix" (token based; a trailing * matches any further tokens, e.g. "terraform apply*") or "regex" (JavaScript, no flags)',
  pattern: `string, at most ${withAction ? GUARD_LIMITS.maxPatternLength : TEST_QUEUE_LIMITS.maxPatternLength} characters; regexes must not backtrack catastrophically (no backreferences, no nested or alternating repetition)`,
  target:
    'regex only: "canonical" (default; wrappers like sudo/env and flags normalised) or "raw" (the command as typed)',
  ...(withAction
    ? { action: '"allow" | "ask" | "deny" (an allow rule exempts matches from the built-in rules)' }
    : {})
})

const listEdit = (what: string): string =>
  `either the full array (replaces the list) or { "add": [${what}...], "remove": ["<rule id>"...] }`

/** Allowed fields, value ranges and ids for one section. */
export function sectionSchema(section: AssistantSection, catalog: AssistantCatalog): Json {
  const L = TEST_QUEUE_LIMITS
  switch (section) {
    case 'guard':
      return {
        global: {
          enabled: 'boolean (turning it off removes all protection)',
          categories: `object category -> action, merged into the current ones. Categories: ${list(GUARD_CATEGORY_IDS)}. Actions: ${list(GUARD_ACTIONS)}`,
          ruleOverrides:
            'object built-in rule id -> action, merged into the current overrides; null or "category" removes an override (the rule follows its category again)',
          customRules: listEdit('rule')
        },
        project: {
          categories:
            'object category -> action or "inherit"/null (removes the project override), merged into the project ones',
          ruleOverrides: 'as global, for this project only',
          customRules: `${listEdit('rule')}; checked after the global rules`
        },
        rule: ruleShape(true),
        precedence:
          'Custom rules are checked first (deny > ask > allow among matches); otherwise the built-in rule override, then the category action. Some rules cap their category action at "ask" (maxAction) unless overridden.',
        builtInRules: catalog.guardRules.map((r) => ({
          id: r.id,
          category: r.category,
          name: en(r.label),
          example: r.example,
          ...(r.maxAction ? { maxAction: r.maxAction } : {}),
          ...(r.defaultAction ? { defaultAction: r.defaultAction } : {})
        })),
        categoryNames: Object.fromEntries(
          GUARD_CATEGORY_IDS.map((id) => [id, en(`guard.categories.${id}`)])
        ),
        testWith:
          'test_guard({ input, tool?, projectId? }) evaluates a command (or a path for Write/Edit) with the current settings.'
      }
    case 'testQueue':
      return {
        global: {
          enabled: 'boolean (the queue is opt-in)',
          mode: '"fixed" (maxConcurrent runs) or "auto" (by CPU and memory load)',
          maxConcurrent: `integer ${L.maxConcurrent.min}-${L.maxConcurrent.max} (fixed mode)`,
          auto: {
            maxConcurrent: `integer ${L.autoMaxConcurrent.min}-${L.autoMaxConcurrent.max} or null (automatic)`,
            cpuHighPercent: `integer ${L.cpuHighPercent.min}-${L.cpuHighPercent.max}`,
            cpuResumePercent: `integer ${L.cpuResumePercent.min}-${L.cpuResumePercent.max}, kept below cpuHighPercent`,
            minAvailableMemoryPercent: `integer ${L.minAvailableMemoryPercent.min}-${L.minAvailableMemoryPercent.max}`,
            rampUpSeconds: `integer ${L.rampUpSeconds.min}-${L.rampUpSeconds.max}`
          },
          maxWaitMinutes: `integer ${L.maxWaitMinutes.min}-${L.maxWaitMinutes.max}`,
          startGraceSeconds: `integer ${L.startGraceSeconds.min}-${L.startGraceSeconds.max}`,
          backgroundMaxHoldMinutes: `integer ${L.backgroundMaxHoldMinutes.min}-${L.backgroundMaxHoldMinutes.max}`,
          disabledBuiltins:
            'built-in ids switched off: the full array, or { "add": [...], "remove": [...] }',
          customPatterns: `extra commands that count as tests: ${listEdit('pattern')}`
        },
        project: {
          mode: '"inherit" or "off" (never queue this project\'s commands)',
          disabledBuiltins: 'as global, for this project only',
          customPatterns: 'as global, for this project only'
        },
        pattern: ruleShape(false),
        builtins: catalog.testBuiltins.map((b) => ({
          id: b.id,
          group: b.group,
          label: b.label,
          example: b.example
        })),
        testWith:
          'classify_test_command({ command, projectId? }) classifies a command with the current rules.'
      }
    case 'claude':
      return {
        global: {
          permissionMode: `one of ${list(PERMISSION_MODES)}; "bypassPermissions" skips every permission check and the user must confirm it`,
          allowBypass:
            'boolean: bypass permissions reachable with Shift+Tab in new tabs (also confirmed by the user)'
        },
        project: { permissionMode: `one of ${list(PERMISSION_MODES)} or "inherit"` },
        note: 'Applies to Claude tabs started afterwards.'
      }
    case 'usage':
      return {
        global: {
          display: '"used" or "remaining"',
          trayEnabled: 'boolean: menu bar item (macOS)',
          trayMetric: '"session", "weekly" or "both"',
          trayAccount:
            '"auto" (closest to a limit), "selected" or an account id from get_settings_overview'
        }
      }
    case 'general':
      return {
        global: { language: '"tr", "en" or null (follow the system)', launchAtLogin: 'boolean' }
      }
  }
}
