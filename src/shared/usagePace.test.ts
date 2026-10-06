import { describe, expect, it } from 'vitest'
import { PERIOD_MS, evaluatePace, forecast, isReset, runOutInMs, usageLevel } from './usagePace'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

/** A window that started `elapsed` ms ago. */
const windowAt = (
  used: number,
  elapsed: number,
  period: number
): { usedPercentage: number; resetsAt: number } => ({
  usedPercentage: used,
  resetsAt: NOW + period - elapsed
})

describe('evaluatePace', () => {
  it('returns null without usage, after the reset or too early', () => {
    const periodMs = PERIOD_MS.fiveHour
    expect(evaluatePace({ used: 0, resetsAt: NOW + HOUR, periodMs, now: NOW })).toBeNull()
    expect(evaluatePace({ used: 40, resetsAt: NOW - 1, periodMs, now: NOW })).toBeNull()
    // 30 s into a five hour window.
    expect(
      evaluatePace({ used: 5, resetsAt: NOW + periodMs - 30_000, periodMs, now: NOW })
    ).toBeNull()
  })

  it('classifies ahead, on track and behind', () => {
    const periodMs = PERIOD_MS.fiveHour
    const at = (used: number): string | undefined =>
      evaluatePace({ used, resetsAt: NOW + periodMs / 2, periodMs, now: NOW })?.status
    expect(at(40)).toBe('ahead') // projected 80
    expect(at(48)).toBe('onTrack') // projected 96
    expect(at(60)).toBe('behind') // projected 120
  })

  it('treats a maxed window as behind', () => {
    const periodMs = PERIOD_MS.sevenDay
    const pace = evaluatePace({ used: 100, resetsAt: NOW + 6 * DAY, periodMs, now: NOW })
    expect(pace?.status).toBe('behind')
  })
})

describe('runOutInMs', () => {
  it('estimates when the limit is hit before the reset', () => {
    const periodMs = PERIOD_MS.fiveHour
    // 60% after 2 h: 30%/h, the remaining 40% takes 80 min; reset is 3 h away.
    const inMs = runOutInMs({ used: 60, resetsAt: NOW + 3 * HOUR, periodMs, now: NOW })
    expect(inMs).toBeCloseTo(80 * 60_000, -3)
  })

  it('returns null when the pace holds until the reset', () => {
    const periodMs = PERIOD_MS.fiveHour
    expect(runOutInMs({ used: 30, resetsAt: NOW + 3 * HOUR, periodMs, now: NOW })).toBeNull()
  })
})

describe('forecast', () => {
  it('stays quiet early in the window', () => {
    // 20 min into five hours (< 10%), even with a heavy burn.
    expect(forecast(windowAt(30, 20 * 60_000, PERIOD_MS.fiveHour), 'fiveHour', NOW)).toBeNull()
  })

  it('stays quiet on a steady burn', () => {
    // 2 days into 7 days with 28%: projected 98.
    expect(forecast(windowAt(28, 2 * DAY, PERIOD_MS.sevenDay), 'sevenDay', NOW)).toBeNull()
  })

  it('warns about a heavy burn with a plausible ETA', () => {
    const result = forecast(windowAt(60, 2 * HOUR, PERIOD_MS.fiveHour), 'fiveHour', NOW)
    expect(result?.kind).toBe('runsOut')
    if (result?.kind !== 'runsOut') return
    expect(result.inMs).toBeGreaterThan(70 * 60_000)
    expect(result.inMs).toBeLessThan(90 * 60_000)
    expect(result.percent).toBe(50) // projected 150
  })

  it('reports a light burn as under the limit', () => {
    // 35% after 2.5 h of 5 h: projected 70, 30% under.
    expect(forecast(windowAt(35, 2.5 * HOUR, PERIOD_MS.fiveHour), 'fiveHour', NOW)).toEqual({
      kind: 'under',
      percent: 30
    })
  })

  it('says nothing about a window that already reset or is maxed', () => {
    expect(forecast({ usedPercentage: 80, resetsAt: NOW - 1 }, 'fiveHour', NOW)).toBeNull()
    expect(forecast(windowAt(100, 3 * HOUR, PERIOD_MS.fiveHour), 'fiveHour', NOW)).toBeNull()
    expect(forecast(null, 'fiveHour', NOW)).toBeNull()
  })
})

describe('isReset', () => {
  it('is true once the reset time passed', () => {
    expect(isReset({ usedPercentage: 90, resetsAt: NOW - 1 }, NOW)).toBe(true)
    expect(isReset({ usedPercentage: 90, resetsAt: NOW }, NOW)).toBe(true)
    expect(isReset({ usedPercentage: 90, resetsAt: NOW + 1 }, NOW)).toBe(false)
  })
})

describe('usageLevel', () => {
  it('combines usage and pace', () => {
    expect(usageLevel(20, null)).toBe('calm')
    expect(usageLevel(20, { projected: 95, status: 'onTrack' })).toBe('warn')
    expect(usageLevel(55, { projected: 70, status: 'ahead' })).toBe('warn')
    expect(usageLevel(30, { projected: 130, status: 'behind' })).toBe('danger')
    expect(usageLevel(90, null)).toBe('danger')
  })
})
