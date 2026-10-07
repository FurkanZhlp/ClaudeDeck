import type { DailyUsage } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { sparklinePath, sparklinePoints } from './sparkline'
import { dailyTotals, dayKey, rangeTotals, trendDays } from './stats'

describe('sparklinePoints', () => {
  it('centres each value in its column with the peak at the top inset', () => {
    const points = sparklinePoints([0, 5, 10], 120, 20, 2)
    expect(points.map((p) => p.x)).toEqual([20, 60, 100])
    expect(points.map((p) => p.y)).toEqual([18, 10, 2])
  })

  it('keeps an all zero series on the baseline', () => {
    expect(sparklinePoints([0, 0], 10, 10, 1).every((p) => p.y === 9)).toBe(true)
    expect(sparklinePoints([], 10, 10, 1)).toEqual([])
  })
})

describe('sparklinePath', () => {
  it('draws a line and optionally closes it along the baseline', () => {
    const points = [
      { x: 0, y: 5 },
      { x: 10, y: 1 }
    ]
    expect(sparklinePath(points)).toBe('M0 5 L10 1')
    expect(sparklinePath(points, 8)).toBe('M0 5 L10 1 L10 8 L0 8 Z')
    expect(sparklinePath([])).toBe('')
  })
})

describe('cost ranges', () => {
  const NOW = new Date(2026, 9, 7, 15).getTime()
  const day = (offset: number, costUSD: number): DailyUsage => ({
    date: dayKey(NOW, offset),
    costUSD,
    tokens: { input: 10, output: 0, cacheWrite: 0, cacheRead: 0 }
  })
  const stats = [
    { accountId: 'a', updatedAt: NOW, days: [day(-10, 4), day(-1, 2), day(0, 1)] },
    { accountId: 'b', updatedAt: NOW, days: [day(0, 3)] }
  ]

  it('sums accounts per day, oldest first, filling empty days', () => {
    const days = dailyTotals(stats, 3, NOW)
    expect(days.map((d) => d.costUSD)).toEqual([0, 2, 4])
    expect(days[2]).toMatchObject({ date: dayKey(NOW), tokens: 20 })
  })

  it('totals today, the week and the month', () => {
    expect(rangeTotals(stats, 'today', NOW).costUSD).toBe(4)
    expect(rangeTotals(stats, 'week', NOW).costUSD).toBe(6)
    expect(rangeTotals(stats, 'month', NOW).costUSD).toBe(10)
  })

  it('draws at least a week of trend', () => {
    expect(trendDays('today')).toBe(7)
    expect(trendDays('month')).toBe(30)
  })
})
