import type { UsageDisplay, UsageWindow } from './types'
import { isReset } from './usagePace'

/** "%62" in Turkish, "62%" in English. */
export const formatPercent = (value: number, language: string): string =>
  new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(
    value / 100
  )

/** Used percentage (0-100) of a window; a window that rolled over counts as unused, none as null. */
export function windowUsed(window: UsageWindow | null | undefined, now: number): number | null {
  if (!window) return null
  return isReset(window, now) ? 0 : Math.min(100, Math.max(0, window.usedPercentage))
}

/** The number to show for a used percentage in the chosen display mode. */
export const displayPercent = (used: number, display: UsageDisplay): number =>
  display === 'remaining' ? 100 - used : used
