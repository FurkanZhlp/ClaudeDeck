import type { UsageWindow } from './types'

/*
 * Pace logic ported from OpenUsage (MIT License, robinebers/openusage,
 * `Sources/OpenUsage/Support/Pace.swift`): project the current burn rate over the whole window
 * and compare it with the limit.
 */

export type UsageWindowKind = 'fiveHour' | 'sevenDay'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Length of each rolling usage window. */
export const PERIOD_MS: Record<UsageWindowKind, number> = {
  fiveHour: 5 * HOUR_MS,
  sevenDay: 7 * 24 * HOUR_MS
}

/** Projected usage at or below this (percent of the limit) is comfortably within it. */
const AHEAD_MAX = 90
/** Projected usage up to the limit itself is on track; anything above runs out early. */
const ON_TRACK_MAX = 100
/** A pace is not judged before at least this much of the window passed (and one minute). */
const MIN_ELAPSED_RATIO = 0.01
const MIN_ELAPSED_MS = MINUTE_MS
/** The forecast line waits for this share of the window, early bursts say little. */
const FORECAST_MIN_ELAPSED_RATIO = 0.1
/** Distance from the limit (percentage points) worth mentioning when nothing runs out. */
const FORECAST_MIN_DELTA = 25

export type PaceStatus = 'ahead' | 'onTrack' | 'behind'

export interface Pace {
  /** Usage at reset if the current rate holds, in percent of the limit (can exceed 100). */
  projected: number
  status: PaceStatus
}

export interface PaceInput {
  /** 0-100. */
  used: number
  /** Epoch ms. */
  resetsAt: number
  periodMs: number
  now: number
}

export type Forecast =
  | { kind: 'runsOut'; inMs: number; percent: number }
  | { kind: 'over'; percent: number }
  | { kind: 'under'; percent: number }

const elapsedMs = ({ resetsAt, periodMs, now }: PaceInput): number =>
  Math.min(periodMs, Math.max(0, periodMs - (resetsAt - now)))

export function evaluatePace(input: PaceInput): Pace | null {
  const { used, resetsAt, periodMs, now } = input
  if (used <= 0 || now >= resetsAt) return null
  const elapsed = elapsedMs(input)
  if (elapsed < Math.max(MIN_ELAPSED_MS, periodMs * MIN_ELAPSED_RATIO)) return null

  const projected = (used / elapsed) * periodMs
  if (used >= 100) return { projected, status: 'behind' }
  const status: PaceStatus =
    projected <= AHEAD_MAX ? 'ahead' : projected <= ON_TRACK_MAX ? 'onTrack' : 'behind'
  return { projected, status }
}

/** Time until the limit is reached at the current rate, when that happens before the reset. */
export function runOutInMs(input: PaceInput): number | null {
  const pace = evaluatePace(input)
  if (!pace || pace.status !== 'behind' || input.used >= 100) return null
  const ratePerMs = input.used / elapsedMs(input)
  const inMs = (100 - input.used) / ratePerMs
  return input.now + inMs < input.resetsAt ? inMs : null
}

/** The window already rolled over since Claude Code last reported it. */
export const isReset = (window: UsageWindow, now: number): boolean => window.resetsAt <= now

/** What the usage panel says about the window, or null when there is nothing worth saying. */
export function forecast(
  window: UsageWindow | null,
  kind: UsageWindowKind,
  now: number
): Forecast | null {
  if (!window || isReset(window, now) || window.usedPercentage >= 100) return null
  const input: PaceInput = {
    used: window.usedPercentage,
    resetsAt: window.resetsAt,
    periodMs: PERIOD_MS[kind],
    now
  }
  if (elapsedMs(input) < input.periodMs * FORECAST_MIN_ELAPSED_RATIO) return null
  const pace = evaluatePace(input)
  if (!pace) return null

  const delta = pace.projected - 100
  const percent = Math.round(Math.abs(delta))
  const inMs = runOutInMs(input)
  if (inMs !== null) return { kind: 'runsOut', inMs, percent }
  if (Math.abs(delta) < FORECAST_MIN_DELTA) return null
  return delta > 0 ? { kind: 'over', percent } : { kind: 'under', percent }
}

export type UsageLevel = 'calm' | 'warn' | 'danger'

const WARN_AT = 50
const DANGER_AT = 85

/** Meter colour: by how much is used and how fast it is going. */
export function usageLevel(used: number, pace: Pace | null): UsageLevel {
  if (used >= DANGER_AT || pace?.status === 'behind') return 'danger'
  if (used >= WARN_AT || pace?.status === 'onTrack') return 'warn'
  return 'calm'
}
