import { describe, expect, it } from 'vitest'
import type { TestPattern, TestQueueSettingsPatch } from '../../shared/types'
import {
  applyProjectTestQueuePatch,
  applyTestQueuePatch,
  cleanPatterns,
  defaultTestQueueSettings,
  withTestQueueDefaults
} from './testQueueSettings'

let n = 0
const newId = (): string => `gen${++n}`
const apply = (patch: TestQueueSettingsPatch): ReturnType<typeof applyTestQueuePatch> =>
  applyTestQueuePatch(defaultTestQueueSettings(), patch, newId)

describe('withTestQueueDefaults', () => {
  it('returns the defaults for missing or broken values', () => {
    expect(withTestQueueDefaults(undefined)).toEqual(defaultTestQueueSettings())
    expect(withTestQueueDefaults('x')).toEqual(defaultTestQueueSettings())
  })

  it('deep merges saved values over the defaults', () => {
    const merged = withTestQueueDefaults({
      enabled: true,
      auto: { cpuHighPercent: 90 },
      customPatterns: 'nope'
    })
    expect(merged.enabled).toBe(true)
    expect(merged.mode).toBe('auto')
    expect(merged.auto).toEqual({ ...defaultTestQueueSettings().auto, cpuHighPercent: 90 })
    expect(merged.customPatterns).toEqual([])
  })
})

describe('applyTestQueuePatch', () => {
  it('starts disabled in auto mode', () => {
    expect(defaultTestQueueSettings()).toMatchObject({
      enabled: false,
      mode: 'auto',
      maxConcurrent: 2,
      maxWaitMinutes: 60
    })
  })

  it('clamps and rounds numbers', () => {
    const next = apply({
      maxConcurrent: 99,
      maxWaitMinutes: 0,
      startGraceSeconds: 30.6,
      backgroundMaxHoldMinutes: -5,
      auto: { maxConcurrent: 0, rampUpSeconds: 9999 }
    })
    expect(next.maxConcurrent).toBe(32)
    expect(next.maxWaitMinutes).toBe(1)
    expect(next.startGraceSeconds).toBe(31)
    expect(next.backgroundMaxHoldMinutes).toBe(1)
    expect(next.auto.maxConcurrent).toBe(1)
    expect(next.auto.rampUpSeconds).toBe(600)
  })

  it('keeps untouched auto fields and allows the automatic limit to be reset', () => {
    const limited = apply({ auto: { maxConcurrent: 4 } })
    expect(limited.auto.cpuHighPercent).toBe(85)
    const reset = applyTestQueuePatch(limited, { auto: { maxConcurrent: null } }, newId)
    expect(reset.auto.maxConcurrent).toBeNull()
  })

  it('keeps the resume threshold below the saturation threshold', () => {
    expect(apply({ auto: { cpuHighPercent: 50 } }).auto.cpuResumePercent).toBe(49)
    expect(apply({ auto: { cpuResumePercent: 95 } }).auto.cpuResumePercent).toBe(84)
  })

  it('rejects wrong types and unknown modes', () => {
    expect(() => apply({ mode: 'fast' as 'auto' })).toThrowError('INVALID')
    expect(() => apply({ enabled: 'yes' as unknown as boolean })).toThrowError('INVALID')
    expect(() => apply({ maxConcurrent: Number.NaN })).toThrowError('INVALID')
    expect(() => apply({ maxWaitMinutes: '5' as unknown as number })).toThrowError('INVALID')
    expect(() => apply({ auto: 'x' as never })).toThrowError('INVALID')
    expect(() => apply(null as never)).toThrowError('INVALID')
  })

  it('validates and de-duplicates disabled built-in ids', () => {
    expect(
      apply({ disabledBuiltins: ['js.vitest', 'js.vitest', 'go.test'] }).disabledBuiltins
    ).toEqual(['js.vitest', 'go.test'])
    expect(() => apply({ disabledBuiltins: ['bad id'] })).toThrowError('INVALID')
    expect(() => apply({ disabledBuiltins: 'x' as never })).toThrowError('INVALID')
  })
})

describe('cleanPatterns', () => {
  it('trims, keeps valid ids and generates missing or duplicate ones', () => {
    const result = cleanPatterns(
      [
        { id: 'keep', kind: 'prefix', pattern: ' make e2e* ' },
        { id: 'keep', kind: 'regex', pattern: '^bin/check' },
        { kind: 'regex', pattern: 'test', target: 'raw' }
      ],
      () => 'new'
    )
    expect(result).toEqual<TestPattern[]>([
      { id: 'keep', kind: 'prefix', pattern: 'make e2e*' },
      { id: 'new', kind: 'regex', pattern: '^bin/check', target: 'canonical' },
      { id: 'new', kind: 'regex', pattern: 'test', target: 'raw' }
    ])
  })

  it('rejects invalid rules', () => {
    const bad: unknown[] = [
      { kind: 'glob', pattern: 'x' },
      { kind: 'prefix', pattern: '   ' },
      { kind: 'prefix', pattern: 'x'.repeat(301) },
      { kind: 'regex', pattern: '(' },
      { kind: 'regex', pattern: 'x', target: 'other' },
      'x'
    ]
    for (const rule of bad) expect(() => cleanPatterns([rule], newId)).toThrowError('INVALID')
  })

  it('allows at most 100 rules', () => {
    const rules = Array.from({ length: 101 }, () => ({ kind: 'prefix', pattern: 'x' }))
    expect(() => cleanPatterns(rules, newId)).toThrowError('INVALID')
    expect(cleanPatterns(rules.slice(1), newId)).toHaveLength(100)
  })
})

describe('applyProjectTestQueuePatch', () => {
  it('returns null when the result equals the defaults', () => {
    expect(applyProjectTestQueuePatch(undefined, { mode: 'inherit' }, newId)).toBeNull()
  })

  it('merges with the current overrides', () => {
    const off = applyProjectTestQueuePatch(undefined, { mode: 'off' }, newId)
    expect(off).toEqual({ mode: 'off', disabledBuiltins: [], customPatterns: [] })
    const next = applyProjectTestQueuePatch(off!, { disabledBuiltins: ['js.jest'] }, newId)
    expect(next).toEqual({ mode: 'off', disabledBuiltins: ['js.jest'], customPatterns: [] })
    expect(() => applyProjectTestQueuePatch(next!, { mode: 'x' as 'off' }, newId)).toThrowError(
      'INVALID'
    )
  })
})

describe('withTestQueueDefaults on load', () => {
  it('clamps saved numbers and replaces broken ones with defaults', () => {
    const loaded = withTestQueueDefaults({
      enabled: 'yes',
      mode: 'turbo',
      maxConcurrent: 1e9,
      maxWaitMinutes: 2.4,
      startGraceSeconds: 'x',
      backgroundMaxHoldMinutes: -1,
      auto: { maxConcurrent: 'many', cpuHighPercent: 50, cpuResumePercent: 90, rampUpSeconds: NaN }
    })
    const defaults = defaultTestQueueSettings()
    expect(loaded.enabled).toBe(false)
    expect(loaded.mode).toBe(defaults.mode)
    expect(loaded.maxConcurrent).toBe(32)
    expect(loaded.maxWaitMinutes).toBe(2)
    expect(Number.isInteger(loaded.maxWaitMinutes)).toBe(true)
    expect(loaded.startGraceSeconds).toBe(defaults.startGraceSeconds)
    expect(loaded.backgroundMaxHoldMinutes).toBe(1)
    expect(loaded.auto).toEqual({
      ...defaults.auto,
      maxConcurrent: null,
      cpuHighPercent: 50,
      cpuResumePercent: 49
    })
  })

  it('drops saved rules that would be refused now, unsafe regexes included', () => {
    const loaded = withTestQueueDefaults({
      disabledBuiltins: ['ok-id', '../bad', 'ok-id', 3],
      customPatterns: [
        { id: 'a', kind: 'regex', pattern: '^pnpm e2e' },
        { id: 'b', kind: 'regex', pattern: '(a+)+$' },
        { id: 'c', kind: 'regex', pattern: '(' },
        { id: 'a', kind: 'prefix', pattern: 'make test' },
        'junk'
      ]
    })
    expect(loaded.disabledBuiltins).toEqual(['ok-id'])
    expect(loaded.customPatterns.map((p) => p.pattern)).toEqual(['^pnpm e2e', 'make test'])
    expect(new Set(loaded.customPatterns.map((p) => p.id)).size).toBe(2)
  })
})

describe('cleanPatterns ReDoS check', () => {
  it('refuses regexes with nested repetition, repeated alternation or backreferences', () => {
    for (const pattern of ['(a+)+', '(x|xy)*', '(a)\\1']) {
      expect(() => cleanPatterns([{ kind: 'regex', pattern }], newId)).toThrow('INVALID')
    }
    expect(cleanPatterns([{ kind: 'regex', pattern: '^(npm|pnpm) e2e' }], newId)).toHaveLength(1)
  })
})
