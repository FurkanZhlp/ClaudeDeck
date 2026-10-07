import type { UsageDisplay, UsageWindow } from '@shared/types'
import { displayPercent } from '@shared/usageDisplay'
import { elapsedFraction, markerFraction } from './ring'
import {
  PERIOD_MS,
  evaluatePace,
  isReset,
  usageLevel,
  type UsageLevel,
  type UsageWindowKind
} from '@shared/usagePace'

/** Arc colour: the account's own colour while calm, the risk token once it needs attention. */
const levelColor = (level: UsageLevel, calm: string): string =>
  level === 'calm' ? calm : `var(--${level})`

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

/**
 * Bar fill (0-100) for the display mode: used fills up, remaining shows what is left.
 * A window that rolled over counts as unused (full in remaining mode, like the menu bar);
 * only a missing window leaves the bar empty.
 */
export function meterFill(
  window: UsageWindow | null,
  state: MeterState,
  display: UsageDisplay
): number {
  return window ? displayPercent(state.used, display) : 0
}

export interface RingWindow extends MeterState {
  kind: UsageWindowKind
  /** False without any report for the window. */
  active: boolean
  /** Arc fill for the display mode, 0-100. */
  fill: number
  /** Arc colour. */
  color: string
  /** Now tick position (0-1) for the display mode, null when the window is over or missing. */
  marker: number | null
}

/** Everything a ring needs to draw one window. */
export function ringWindow(
  window: UsageWindow | null,
  kind: UsageWindowKind,
  now: number,
  display: UsageDisplay,
  accountColor: string
): RingWindow {
  const state = meterState(window, kind, now)
  const elapsed = elapsedFraction(window, kind, now)
  return {
    ...state,
    kind,
    active: window !== null,
    fill: meterFill(window, state, display),
    color: levelColor(state.level, accountColor),
    marker: elapsed === null ? null : markerFraction(elapsed, display)
  }
}
