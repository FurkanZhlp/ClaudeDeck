import { useTranslation } from 'react-i18next'
import type { Account, AccountUsage } from '@shared/types'
import { displayPercent } from '@shared/usageDisplay'
import { useUsageDisplay } from './display'
import { formatPercent } from './format'
import { ringWindow, type RingWindow } from './meter'
import { mostCritical } from './ring'
import { useUsage } from './usageStore'

export interface AccountRingsModel {
  session: RingWindow
  weekly: RingWindow
  /** Window shown in the ring centre, the one with the highest used share. */
  critical: RingWindow | null
}

/** Ring state of both windows of an account in the current display mode. */
export function useRingModel(account: Account, usage: AccountUsage | undefined): AccountRingsModel {
  const now = useUsage((s) => s.now)
  const display = useUsageDisplay()
  const session = ringWindow(usage?.fiveHour ?? null, 'fiveHour', now, display, account.color)
  const weekly = ringWindow(usage?.sevenDay ?? null, 'sevenDay', now, display, account.color)
  const kind = mostCritical([
    { kind: session.kind, used: session.active ? session.used : null },
    { kind: weekly.kind, used: weekly.active ? weekly.used : null }
  ])
  return { session, weekly, critical: kind === 'fiveHour' ? session : kind ? weekly : null }
}

/** Percent text of a window in the display mode, e.g. "%88". */
export function useWindowPercent(): (window: RingWindow) => string {
  const { i18n } = useTranslation()
  const display = useUsageDisplay()
  return (window) => formatPercent(displayPercent(window.used, display), i18n.language)
}
