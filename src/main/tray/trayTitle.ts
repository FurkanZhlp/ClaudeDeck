import type { Account, AccountUsage, TrayMetric, UsageDisplay } from '../../shared/types'
import { displayPercent, formatPercent, windowUsed } from '../../shared/usageDisplay'

export const TRAY_ACCOUNT_AUTO = 'auto'
export const TRAY_ACCOUNT_SELECTED = 'selected'

const SEPARATOR = ' · '

/** Highest used percentage across the session and weekly windows, or null without data. */
function risk(usage: AccountUsage | undefined, now: number): number | null {
  if (!usage) return null
  const values = [windowUsed(usage.fiveHour, now), windowUsed(usage.sevenDay, now)].filter(
    (v): v is number => v !== null
  )
  return values.length > 0 ? Math.max(...values) : null
}

/**
 * The account the menu bar follows: a fixed account id, the account selected in the app, or
 * (for 'auto' and as the fallback) the one closest to a limit. Null when there are no accounts.
 */
export function pickTrayAccount(
  accounts: Account[],
  usage: AccountUsage[],
  choice: string,
  selectedId: string | null,
  now: number
): string | null {
  const ids = new Set(accounts.map((a) => a.id))
  if (choice !== TRAY_ACCOUNT_AUTO && choice !== TRAY_ACCOUNT_SELECTED && ids.has(choice)) {
    return choice
  }
  if (choice === TRAY_ACCOUNT_SELECTED && selectedId && ids.has(selectedId)) return selectedId

  const byId = new Map(usage.map((u) => [u.accountId, u]))
  let best: string | null = null
  let bestRisk = -1
  for (const account of accounts) {
    const value = risk(byId.get(account.id), now)
    if (value !== null && value > bestRisk) {
      best = account.id
      bestRisk = value
    }
  }
  return best ?? accounts[0]?.id ?? null
}

/** "5% · 62%" (both), "5%" (session) or "62%" (weekly); windows without data are left out. */
export function trayTitle(
  usage: AccountUsage | undefined,
  metric: TrayMetric,
  display: UsageDisplay,
  language: string,
  now: number
): string {
  if (!usage) return ''
  const windows =
    metric === 'session'
      ? [usage.fiveHour]
      : metric === 'weekly'
        ? [usage.sevenDay]
        : [usage.fiveHour, usage.sevenDay]
  return windows
    .map((window) => windowUsed(window, now))
    .filter((used): used is number => used !== null)
    .map((used) => formatPercent(displayPercent(used, display), language))
    .join(SEPARATOR)
}
