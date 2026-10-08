import { describe, expect, it } from 'vitest'
import { GUARD_LIMITS } from '@shared/guardLimits'
import type {
  GuardLogEntry,
  GuardRuleInfo,
  GuardSettings,
  TestQueueHookStatus
} from '@shared/types'
import {
  DENY_BURST_MS,
  FOLLOW_CATEGORY,
  INHERIT,
  checkGuardPattern,
  excerpt,
  followedRuleAction,
  guardHooksOff,
  needsAllowConfirm,
  nextDenyBurst,
  overrideCount,
  prependLogEntry,
  projectCategoryAction,
  ruleActionAvailable,
  rulesByCategory,
  withProjectChoice,
  withRuleChoice
} from './guardModel'

const rule = (id: string, category: GuardRuleInfo['category']): GuardRuleInfo => ({
  id,
  category,
  label: `guard.rules.${id}`,
  example: 'x'
})

const entry = (id: string): GuardLogEntry => ({
  id,
  at: 0,
  sessionId: 's',
  projectId: 'p',
  accountId: 'a',
  tool: 'Bash',
  category: 'git',
  ruleId: 'git.forcePush',
  action: 'deny',
  excerpt: 'echo GUARD-SENTINEL'
})

const settings: GuardSettings = {
  enabled: true,
  categories: {
    disk: 'deny',
    sensitive: 'deny',
    git: 'ask',
    fetchExec: 'ask',
    docker: 'ask',
    database: 'ask',
    publish: 'ask',
    system: 'ask'
  },
  ruleOverrides: {},
  customRules: []
}

describe('rulesByCategory', () => {
  it('groups rules and keeps their order', () => {
    const groups = rulesByCategory([
      rule('git.a', 'git'),
      rule('disk.a', 'disk'),
      rule('git.b', 'git')
    ])
    expect([...groups.keys()]).toEqual(['git', 'disk'])
    expect(groups.get('git')?.map((r) => r.id)).toEqual(['git.a', 'git.b'])
  })
})

describe('rule and project choices', () => {
  it('following the category removes the override', () => {
    expect(withRuleChoice({ 'git.a': 'deny' }, 'git.a', FOLLOW_CATEGORY)).toEqual({})
    expect(withRuleChoice({}, 'git.a', 'allow')).toEqual({ 'git.a': 'allow' })
  })

  it('inheriting removes the project category', () => {
    expect(withProjectChoice({ git: 'deny' }, 'git', INHERIT)).toEqual({})
    expect(withProjectChoice({}, 'docker', 'allow')).toEqual({ docker: 'allow' })
  })

  it('counts overridden rules of a category', () => {
    const rules = [rule('git.a', 'git'), rule('git.b', 'git')]
    expect(overrideCount(rules, { 'git.a': 'allow', 'disk.a': 'deny' })).toBe(1)
  })

  it('uses the project category before the global one', () => {
    expect(projectCategoryAction(settings, undefined, 'git')).toBe('ask')
    expect(
      projectCategoryAction(
        settings,
        { categories: { git: 'deny' }, ruleOverrides: {}, customRules: [] },
        'git'
      )
    ).toBe('deny')
  })
})

describe('needsAllowConfirm', () => {
  it('confirms allow for disk and sensitive only', () => {
    expect(needsAllowConfirm('disk', 'allow')).toBe(true)
    expect(needsAllowConfirm('sensitive', 'allow')).toBe(true)
    expect(needsAllowConfirm('disk', 'ask')).toBe(false)
    expect(needsAllowConfirm('disk', FOLLOW_CATEGORY)).toBe(false)
    expect(needsAllowConfirm('git', 'allow')).toBe(false)
  })
})

describe('activity log', () => {
  it('puts new entries on top and keeps the limit', () => {
    const full = Array.from({ length: GUARD_LIMITS.logSize }, (_, i) => entry(`e${i}`))
    const next = prependLogEntry(full, entry('new'))
    expect(next).toHaveLength(GUARD_LIMITS.logSize)
    expect(next[0].id).toBe('new')
    expect(next.at(-1)?.id).toBe(`e${GUARD_LIMITS.logSize - 2}`)
  })

  it('ignores an entry it already has', () => {
    expect(prependLogEntry([entry('a')], entry('a'))).toHaveLength(1)
  })
})

describe('excerpt', () => {
  it('makes one line and cuts long text', () => {
    expect(excerpt('echo  a\n echo b', 50)).toBe('echo a echo b')
    expect(excerpt('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('nextDenyBurst', () => {
  it('merges denials within the burst window', () => {
    const first = nextDenyBurst(null, 1000)
    expect(first).toEqual({ startedAt: 1000, count: 1 })
    expect(nextDenyBurst(first, 2000)).toEqual({ startedAt: 1000, count: 2 })
  })

  it('starts a new burst after the window', () => {
    const first = nextDenyBurst(null, 0)
    expect(nextDenyBurst(first, DENY_BURST_MS)).toEqual({ startedAt: DENY_BURST_MS, count: 1 })
  })
})

describe('checkGuardPattern', () => {
  it('accepts prefix and safe regex rules', () => {
    expect(checkGuardPattern('prefix', 'terraform apply*')).toEqual({ ok: true })
    expect(checkGuardPattern('regex', '^kubectl delete\\b')).toEqual({ ok: true })
  })

  it('refuses empty, too long, broken and unsafe patterns', () => {
    expect(checkGuardPattern('prefix', '  ')).toMatchObject({ ok: false, reason: 'empty' })
    expect(
      checkGuardPattern('prefix', 'x'.repeat(GUARD_LIMITS.maxPatternLength + 1))
    ).toMatchObject({ ok: false, reason: 'tooLong' })
    expect(checkGuardPattern('regex', '(')).toMatchObject({ ok: false, reason: 'regex' })
    expect(checkGuardPattern('regex', '(a+)+')).toMatchObject({ ok: false, reason: 'unsafe' })
  })
})

describe('rules that do not simply follow their category', () => {
  const plain = rule('git.forcePush', 'git')
  const capped: GuardRuleInfo = {
    ...rule('sensitive.projectAgentConfig', 'sensitive'),
    maxAction: 'ask'
  }
  const strict: GuardRuleInfo = {
    ...rule('system.nestedClaudeEscape', 'system'),
    defaultAction: 'deny'
  }

  it('mirrors the category for a plain rule', () => {
    expect(followedRuleAction(plain, 'deny')).toEqual({ action: 'deny', source: 'category' })
  })
  it('caps a deny at ask', () => {
    expect(followedRuleAction(capped, 'deny')).toEqual({ action: 'ask', source: 'capped' })
    expect(followedRuleAction(capped, 'ask')).toEqual({ action: 'ask', source: 'category' })
  })
  it('keeps a default deny unless the category allows', () => {
    expect(followedRuleAction(strict, 'ask')).toEqual({ action: 'deny', source: 'default' })
    expect(followedRuleAction(strict, 'allow')).toEqual({ action: 'allow', source: 'category' })
  })
  it('offers no deny for a capped rule', () => {
    expect(ruleActionAvailable(capped, 'deny')).toBe(false)
    expect(ruleActionAvailable(capped, 'ask')).toBe(true)
    expect(ruleActionAvailable(strict, 'deny')).toBe(true)
  })
})

describe('guardHooksOff', () => {
  const status = (patch: Partial<TestQueueHookStatus>): TestQueueHookStatus => ({
    accounts: [],
    guardEnabled: true,
    managedHooksOnly: false,
    hooksDisabledProjectIds: [],
    ...patch
  })

  it('is false while the guard is off or nothing is disabled', () => {
    expect(guardHooksOff(null, 'p1')).toBe(false)
    expect(guardHooksOff(status({ guardEnabled: false, managedHooksOnly: true }), 'p1')).toBe(false)
    expect(guardHooksOff(status({}), 'p1')).toBe(false)
  })
  it('flags projects with hooks disabled, or all of them with managed hooks only', () => {
    const some = status({ hooksDisabledProjectIds: ['p1'] })
    expect(guardHooksOff(some, 'p1')).toBe(true)
    expect(guardHooksOff(some, 'p2')).toBe(false)
    expect(guardHooksOff(some)).toBe(true)
    expect(guardHooksOff(status({ managedHooksOnly: true }), 'p2')).toBe(true)
  })
})
