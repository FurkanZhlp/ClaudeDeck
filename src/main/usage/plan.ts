import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AccountPlan } from '../../shared/types'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const lower = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '')

/** Ordered: the first matching rule names the plan. */
const RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /max_?20x/, label: 'Max 20x' },
  { pattern: /max_?5x/, label: 'Max 5x' },
  { pattern: /enterprise/, label: 'Enterprise' },
  { pattern: /team/, label: 'Team' },
  { pattern: /max/, label: 'Max' },
  { pattern: /pro/, label: 'Pro' }
]

/** Plan label from the oauthAccount fields; the rate limit tier is the most specific. */
export function planLabel(oauthAccount: Json): string | null {
  const sources = [
    lower(oauthAccount.organizationRateLimitTier),
    lower(oauthAccount.organizationType),
    lower(oauthAccount.billingType)
  ]
  for (const source of sources) {
    if (!source) continue
    const rule = RULES.find((r) => r.pattern.test(source))
    if (rule) return rule.label
  }
  return null
}

/** Only plan fields are read; tokens and identity in the same file are never touched. */
export function planFromProfile(profile: unknown, accountId: string): AccountPlan {
  const oauth = isObject(profile) && isObject(profile.oauthAccount) ? profile.oauthAccount : null
  if (!oauth) return { accountId, label: null, extraUsageEnabled: null }
  const extra = oauth.hasExtraUsageEnabled
  return {
    accountId,
    label: planLabel(oauth),
    extraUsageEnabled: typeof extra === 'boolean' ? extra : null
  }
}

/** Plan of the account from `<configDir>/.claude.json` (no network). */
export function readAccountPlan(account: Pick<Account, 'id' | 'configDir'>): AccountPlan {
  let profile: unknown = null
  try {
    profile = JSON.parse(readFileSync(join(account.configDir, '.claude.json'), 'utf8'))
  } catch {
    // Missing or unreadable profile (signed out, first run): plan unknown.
  }
  return planFromProfile(profile, account.id)
}
