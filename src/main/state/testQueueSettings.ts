import { DomainError } from '../../shared/errors'
import { isSafeRegex } from '../../shared/safeRegex'
import { TEST_QUEUE_LIMITS as LIMITS, TEST_RULE_ID } from '../../shared/testQueueLimits'
import type {
  ProjectTestQueue,
  TestPattern,
  TestQueueAutoSettings,
  TestQueueSettings,
  TestQueueSettingsPatch
} from '../../shared/types'

export const defaultTestQueueSettings = (): TestQueueSettings => ({
  enabled: false,
  mode: 'auto',
  maxConcurrent: 2,
  auto: {
    maxConcurrent: null,
    cpuHighPercent: 85,
    cpuResumePercent: 65,
    minAvailableMemoryPercent: 15,
    rampUpSeconds: 20
  },
  maxWaitMinutes: 60,
  startGraceSeconds: 120,
  backgroundMaxHoldMinutes: 30,
  disabledBuiltins: [],
  customPatterns: []
})

export const defaultProjectTestQueue = (): ProjectTestQueue => ({
  mode: 'inherit',
  disabledBuiltins: [],
  customPatterns: []
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function clampInt(value: unknown, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID')
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/** A saved number clamped like a patch would be; the default when it is not a number. */
const loadedInt = (
  value: unknown,
  range: { min: number; max: number },
  fallback: number
): number =>
  typeof value === 'number' && Number.isFinite(value) ? clampInt(value, range) : fallback

/**
 * Saved settings as the queue may use them: fields added later get their defaults, numbers are
 * clamped to TEST_QUEUE_LIMITS, and rules that would be refused today (bad ids, regexes that do
 * not compile or could backtrack catastrophically) are dropped. A hand-edited config file can
 * therefore never produce a value a patch could not.
 */
export function withTestQueueDefaults(saved: unknown): TestQueueSettings {
  const defaults = defaultTestQueueSettings()
  if (!isObject(saved)) return defaults
  const auto = isObject(saved.auto) ? saved.auto : {}
  const d = defaults.auto
  const cpuHighPercent = loadedInt(auto.cpuHighPercent, LIMITS.cpuHighPercent, d.cpuHighPercent)
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    mode: saved.mode === 'fixed' || saved.mode === 'auto' ? saved.mode : defaults.mode,
    maxConcurrent: loadedInt(saved.maxConcurrent, LIMITS.maxConcurrent, defaults.maxConcurrent),
    auto: {
      maxConcurrent:
        typeof auto.maxConcurrent === 'number' && Number.isFinite(auto.maxConcurrent)
          ? clampInt(auto.maxConcurrent, LIMITS.autoMaxConcurrent)
          : d.maxConcurrent,
      cpuHighPercent,
      cpuResumePercent: Math.min(
        loadedInt(auto.cpuResumePercent, LIMITS.cpuResumePercent, d.cpuResumePercent),
        cpuHighPercent - 1
      ),
      minAvailableMemoryPercent: loadedInt(
        auto.minAvailableMemoryPercent,
        LIMITS.minAvailableMemoryPercent,
        d.minAvailableMemoryPercent
      ),
      rampUpSeconds: loadedInt(auto.rampUpSeconds, LIMITS.rampUpSeconds, d.rampUpSeconds)
    },
    maxWaitMinutes: loadedInt(saved.maxWaitMinutes, LIMITS.maxWaitMinutes, defaults.maxWaitMinutes),
    startGraceSeconds: loadedInt(
      saved.startGraceSeconds,
      LIMITS.startGraceSeconds,
      defaults.startGraceSeconds
    ),
    backgroundMaxHoldMinutes: loadedInt(
      saved.backgroundMaxHoldMinutes,
      LIMITS.backgroundMaxHoldMinutes,
      defaults.backgroundMaxHoldMinutes
    ),
    disabledBuiltins: Array.isArray(saved.disabledBuiltins)
      ? [
          ...new Set(
            saved.disabledBuiltins.filter(
              (id): id is string => typeof id === 'string' && TEST_RULE_ID.test(id)
            )
          )
        ].slice(0, LIMITS.maxDisabledBuiltins)
      : [],
    customPatterns: loadedPatterns(saved.customPatterns)
  }
}

/** Saved rules that still pass cleanPatterns; the others are dropped one by one. */
function loadedPatterns(value: unknown): TestPattern[] {
  if (!Array.isArray(value)) return []
  const kept: TestPattern[] = []
  const ids = new Set<string>()
  let n = 0
  for (const raw of value.slice(0, LIMITS.maxPatterns)) {
    try {
      const [pattern] = cleanPatterns([raw], () => `loaded-${++n}`)
      if (ids.has(pattern.id)) pattern.id = `loaded-${++n}`
      ids.add(pattern.id)
      kept.push(pattern)
    } catch {
      // Refused today: left out.
    }
  }
  return kept
}

function ruleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > LIMITS.maxDisabledBuiltins) {
    throw new DomainError('INVALID')
  }
  for (const id of value) {
    if (typeof id !== 'string' || !TEST_RULE_ID.test(id)) throw new DomainError('INVALID')
  }
  return [...new Set(value as string[])]
}

/**
 * Validates user rules: prefix or regex, trimmed, at most 300 characters, regexes must compile
 * and pass the ReDoS check (no backreferences, no nested or alternating repetition).
 * Keeps valid unique ids (edits keep their identity) and generates the rest.
 */
export function cleanPatterns(value: unknown, newId: () => string): TestPattern[] {
  if (!Array.isArray(value) || value.length > LIMITS.maxPatterns) throw new DomainError('INVALID')
  const seen = new Set<string>()
  return value.map((raw: unknown): TestPattern => {
    if (!isObject(raw)) throw new DomainError('INVALID')
    const { kind, pattern, target } = raw
    if (kind !== 'prefix' && kind !== 'regex') throw new DomainError('INVALID')
    if (typeof pattern !== 'string') throw new DomainError('INVALID')
    const text = pattern.trim()
    if (!text || text.length > LIMITS.maxPatternLength) throw new DomainError('INVALID')
    let id = typeof raw.id === 'string' && TEST_RULE_ID.test(raw.id) ? raw.id : ''
    if (!id || seen.has(id)) id = newId()
    seen.add(id)
    if (kind === 'prefix') return { id, kind, pattern: text }
    try {
      new RegExp(text)
    } catch {
      throw new DomainError('INVALID')
    }
    if (!isSafeRegex(text)) throw new DomainError('INVALID')
    if (target !== undefined && target !== 'canonical' && target !== 'raw') {
      throw new DomainError('INVALID')
    }
    return { id, kind, pattern: text, target: target ?? 'canonical' }
  })
}

function applyAutoPatch(current: TestQueueAutoSettings, patch: unknown): TestQueueAutoSettings {
  if (!isObject(patch)) throw new DomainError('INVALID')
  const auto = { ...current }
  if (patch.maxConcurrent !== undefined) {
    auto.maxConcurrent =
      patch.maxConcurrent === null ? null : clampInt(patch.maxConcurrent, LIMITS.autoMaxConcurrent)
  }
  if (patch.cpuHighPercent !== undefined) {
    auto.cpuHighPercent = clampInt(patch.cpuHighPercent, LIMITS.cpuHighPercent)
  }
  if (patch.cpuResumePercent !== undefined) {
    auto.cpuResumePercent = clampInt(patch.cpuResumePercent, LIMITS.cpuResumePercent)
  }
  if (patch.minAvailableMemoryPercent !== undefined) {
    auto.minAvailableMemoryPercent = clampInt(
      patch.minAvailableMemoryPercent,
      LIMITS.minAvailableMemoryPercent
    )
  }
  if (patch.rampUpSeconds !== undefined) {
    auto.rampUpSeconds = clampInt(patch.rampUpSeconds, LIMITS.rampUpSeconds)
  }
  // Hysteresis needs a band: resuming at or above the saturation threshold would never clear.
  auto.cpuResumePercent = Math.min(auto.cpuResumePercent, auto.cpuHighPercent - 1)
  return auto
}

/** Applies a settings patch with validation (INVALID) and clamping to TEST_QUEUE_LIMITS. */
export function applyTestQueuePatch(
  current: TestQueueSettings,
  patch: TestQueueSettingsPatch,
  newId: () => string
): TestQueueSettings {
  if (!isObject(patch)) throw new DomainError('INVALID')
  const next: TestQueueSettings = { ...current }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new DomainError('INVALID')
    next.enabled = patch.enabled
  }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'fixed' && patch.mode !== 'auto') throw new DomainError('INVALID')
    next.mode = patch.mode
  }
  if (patch.maxConcurrent !== undefined) {
    next.maxConcurrent = clampInt(patch.maxConcurrent, LIMITS.maxConcurrent)
  }
  if (patch.auto !== undefined) next.auto = applyAutoPatch(current.auto, patch.auto)
  if (patch.maxWaitMinutes !== undefined) {
    next.maxWaitMinutes = clampInt(patch.maxWaitMinutes, LIMITS.maxWaitMinutes)
  }
  if (patch.startGraceSeconds !== undefined) {
    next.startGraceSeconds = clampInt(patch.startGraceSeconds, LIMITS.startGraceSeconds)
  }
  if (patch.backgroundMaxHoldMinutes !== undefined) {
    next.backgroundMaxHoldMinutes = clampInt(
      patch.backgroundMaxHoldMinutes,
      LIMITS.backgroundMaxHoldMinutes
    )
  }
  if (patch.disabledBuiltins !== undefined) next.disabledBuiltins = ruleIds(patch.disabledBuiltins)
  if (patch.customPatterns !== undefined) {
    next.customPatterns = cleanPatterns(patch.customPatterns, newId)
  }
  return next
}

/** Applies a project override patch; returns null when the result equals the defaults. */
export function applyProjectTestQueuePatch(
  current: ProjectTestQueue | undefined,
  patch: Partial<ProjectTestQueue>,
  newId: () => string
): ProjectTestQueue | null {
  if (!isObject(patch)) throw new DomainError('INVALID')
  const next: ProjectTestQueue = { ...(current ?? defaultProjectTestQueue()) }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'inherit' && patch.mode !== 'off') throw new DomainError('INVALID')
    next.mode = patch.mode
  }
  if (patch.disabledBuiltins !== undefined) next.disabledBuiltins = ruleIds(patch.disabledBuiltins)
  if (patch.customPatterns !== undefined) {
    next.customPatterns = cleanPatterns(patch.customPatterns, newId)
  }
  const isDefault =
    next.mode === 'inherit' && !next.disabledBuiltins.length && !next.customPatterns.length
  return isDefault ? null : next
}
