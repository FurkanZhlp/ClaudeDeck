import type { UsageWindow } from '@shared/types'
import {
  PERIOD_MS,
  evaluatePace,
  isReset,
  usageLevel,
  type UsageLevel,
  type UsageWindowKind
} from '@shared/usagePace'

export const LEVEL_COLOR: Record<UsageLevel, string> = {
  calm: 'var(--accent)',
  warn: 'var(--warn)',
  danger: 'var(--danger)'
}

export interface MeterState {
  /** 0-100, zero when the window rolled over since the last report. */
  used: number
  reset: boolean
  level: UsageLevel
}

/** Shared by the panel and the details view so both colour a window the same way. */
export function meterState(
  window: UsageWindow | null,
  kind: UsageWindowKind,
  now: number
): MeterState {
  const reset = window !== null && isReset(window, now)
  const used = window && !reset ? Math.min(100, Math.max(0, window.usedPercentage)) : 0
  const pace =
    window && !reset
      ? evaluatePace({ used, resetsAt: window.resetsAt, periodMs: PERIOD_MS[kind], now })
      : null
  return { used, reset, level: usageLevel(used, pace) }
}
