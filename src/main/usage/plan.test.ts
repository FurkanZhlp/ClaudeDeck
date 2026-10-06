import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planFromProfile, readAccountPlan } from './plan'

const profile = (oauthAccount: Record<string, unknown>): unknown => ({
  userID: 'secret-user-id',
  oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'uuid', ...oauthAccount }
})

describe('planFromProfile', () => {
  it.each([
    [{ organizationRateLimitTier: 'default_claude_max_20x' }, 'Max 20x'],
    [{ organizationRateLimitTier: 'default_claude_max_5x' }, 'Max 5x'],
    [{ organizationType: 'claude_max' }, 'Max'],
    [{ organizationType: 'claude_pro' }, 'Pro'],
    [{ organizationType: 'claude_team' }, 'Team'],
    [{ organizationType: 'claude_enterprise' }, 'Enterprise'],
    [{ organizationRateLimitTier: 'default', organizationType: 'claude_max' }, 'Max'],
    [{ billingType: 'pro_subscription' }, 'Pro'],
    [{ organizationType: 'personal', billingType: 'stripe_subscription' }, null],
    [{}, null]
  ])('%j -> %s', (fields, label) => {
    expect(planFromProfile(profile(fields), 'a').label).toBe(label)
  })

  it('reads extra usage only when it is a boolean', () => {
    expect(planFromProfile(profile({ hasExtraUsageEnabled: true }), 'a').extraUsageEnabled).toBe(
      true
    )
    expect(planFromProfile(profile({ hasExtraUsageEnabled: false }), 'a').extraUsageEnabled).toBe(
      false
    )
    expect(planFromProfile(profile({ hasExtraUsageEnabled: 'yes' }), 'a').extraUsageEnabled).toBe(
      null
    )
  })

  it('returns only plan fields', () => {
    const plan = planFromProfile(
      profile({ organizationType: 'claude_max', hasExtraUsageEnabled: true }),
      'a'
    )
    expect(plan).toEqual({ accountId: 'a', label: 'Max', extraUsageEnabled: true })
  })

  it('handles profiles without an oauth account', () => {
    const unknown = { accountId: 'a', label: null, extraUsageEnabled: null }
    expect(planFromProfile(null, 'a')).toEqual(unknown)
    expect(planFromProfile({ oauthAccount: 'x' }, 'a')).toEqual(unknown)
  })
})

describe('readAccountPlan', () => {
  it('reads the account profile and tolerates a missing or broken one', () => {
    const configDir = join(mkdtempSync(join(tmpdir(), 'claudedeck-plan-')), 'a')
    expect(readAccountPlan({ id: 'a', configDir }).label).toBeNull()

    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), '{ broken')
    expect(readAccountPlan({ id: 'a', configDir }).label).toBeNull()

    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify(profile({ organizationRateLimitTier: 'default_claude_max_20x' }))
    )
    expect(readAccountPlan({ id: 'a', configDir })).toEqual({
      accountId: 'a',
      label: 'Max 20x',
      extraUsageEnabled: null
    })
  })
})
