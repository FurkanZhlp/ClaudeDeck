import { describe, expect, it } from 'vitest'
import { DomainError } from '../../shared/errors'
import {
  applyGuardPatch,
  applyProjectGuardPatch,
  cleanGuardRules,
  defaultGuardSettings,
  withGuardDefaults,
  withProjectGuardDefaults
} from './guardSettings'

let n = 0
const newId = (): string => `g${++n}`
const invalid = (fn: () => unknown): void => {
  expect(fn).toThrow(DomainError)
}

describe('guard settings', () => {
  it('validates patches', () => {
    const base = defaultGuardSettings()
    invalid(() => applyGuardPatch(base, null as never, newId))
    invalid(() => applyGuardPatch(base, { enabled: 'yes' as never }, newId))
    invalid(() => applyGuardPatch(base, { categories: { git: 'maybe' } as never }, newId))
    invalid(() => applyGuardPatch(base, { categories: { custom: 'deny' } as never }, newId))
    invalid(() => applyGuardPatch(base, { ruleOverrides: { 'bad id!': 'deny' } }, newId))
    invalid(() =>
      applyGuardPatch(base, { ruleOverrides: { 'git.forcePush': 'off' as never } }, newId)
    )
    const next = applyGuardPatch(
      base,
      {
        enabled: false,
        categories: { git: 'allow' } as never,
        ruleOverrides: { 'git.clean': 'deny' }
      },
      newId
    )
    expect(next.enabled).toBe(false)
    expect(next.categories).toEqual({ ...base.categories, git: 'allow' })
    expect(next.ruleOverrides).toEqual({ 'git.clean': 'deny' })
  })

  it('validates custom rules like test queue rules, with an action', () => {
    invalid(() => cleanGuardRules('x', newId))
    invalid(() => cleanGuardRules([{ kind: 'glob', pattern: 'x', action: 'deny' }], newId))
    invalid(() => cleanGuardRules([{ kind: 'prefix', pattern: 'x', action: 'block' }], newId))
    invalid(() => cleanGuardRules([{ kind: 'prefix', pattern: '   ', action: 'deny' }], newId))
    invalid(() => cleanGuardRules([{ kind: 'regex', pattern: '(', action: 'deny' }], newId))
    invalid(() => cleanGuardRules([{ kind: 'regex', pattern: '(a+)+$', action: 'deny' }], newId))
    invalid(() =>
      cleanGuardRules([{ kind: 'regex', pattern: 'x', target: 'other', action: 'ask' }], newId)
    )
    invalid(() =>
      cleanGuardRules([{ kind: 'prefix', pattern: 'x'.repeat(301), action: 'ask' }], newId)
    )
    invalid(() =>
      cleanGuardRules(Array(101).fill({ kind: 'prefix', pattern: 'x', action: 'ask' }), newId)
    )
    const rules = cleanGuardRules(
      [
        { id: 'keep', kind: 'regex', pattern: '^terraform', action: 'ask' },
        { id: 'keep', kind: 'prefix', pattern: 'make deploy', action: 'deny' }
      ],
      () => 'fresh'
    )
    expect(rules).toEqual([
      { id: 'keep', kind: 'regex', pattern: '^terraform', target: 'canonical', action: 'ask' },
      { id: 'fresh', kind: 'prefix', pattern: 'make deploy', action: 'deny' }
    ])
  })

  it('loads hand-edited values without failing', () => {
    expect(withGuardDefaults(undefined)).toEqual(defaultGuardSettings())
    expect(withGuardDefaults('nope')).toEqual(defaultGuardSettings())
    const loaded = withGuardDefaults({
      enabled: false,
      categories: { git: 'deny', disk: 'whatever', unknown: 'allow' },
      ruleOverrides: { 'git.clean': 'allow', 'bad id': 'deny', 'git.x': 'nope' },
      customRules: [
        { id: 'a', kind: 'regex', pattern: '(a+)+', action: 'deny' },
        { id: 'b', kind: 'prefix', pattern: 'echo GUARD-SENTINEL-*', action: 'deny' },
        { id: 'b', kind: 'prefix', pattern: 'make x', action: 'ask' }
      ]
    })
    expect(loaded.enabled).toBe(false)
    expect(loaded.categories.git).toBe('deny')
    expect(loaded.categories.disk).toBe('deny')
    expect(loaded.ruleOverrides).toEqual({ 'git.clean': 'allow' })
    expect(loaded.customRules.map((r) => r.id)).toEqual(['b', 'loaded-1'])
  })

  it('keeps project overrides only while something is overridden', () => {
    expect(withProjectGuardDefaults({ categories: {}, ruleOverrides: {} })).toBeUndefined()
    expect(withProjectGuardDefaults({ categories: { git: 'allow', x: 'deny' } })).toEqual({
      categories: { git: 'allow' },
      ruleOverrides: {},
      customRules: []
    })
    expect(applyProjectGuardPatch(undefined, { categories: {} }, newId)).toBeNull()
    expect(applyProjectGuardPatch(undefined, null, newId)).toBeNull()
    invalid(() => applyProjectGuardPatch(undefined, { categories: { git: 'x' } } as never, newId))
    const current = applyProjectGuardPatch(undefined, { categories: { git: 'allow' } }, newId)
    expect(
      applyProjectGuardPatch(
        current ?? undefined,
        { ruleOverrides: { 'docker.prune': 'deny' } },
        newId
      )
    ).toEqual({
      categories: { git: 'allow' },
      ruleOverrides: { 'docker.prune': 'deny' },
      customRules: []
    })
  })
})
