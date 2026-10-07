import { describe, expect, it } from 'vitest'
import { meterFill, meterState, ringWindow } from './meter'

const NOW = 1_000_000_000
const active = { usedPercentage: 40, resetsAt: NOW + 60_000 }
const rolledOver = { usedPercentage: 90, resetsAt: NOW - 1 }

const fill = (window: typeof active | null, display: 'used' | 'remaining'): number =>
  meterFill(window, meterState(window, 'session', NOW), display)

describe('meterFill', () => {
  it('fills with the used or remaining share of an active window', () => {
    expect(fill(active, 'used')).toBe(40)
    expect(fill(active, 'remaining')).toBe(60)
  })

  it('treats a rolled over window as unused', () => {
    expect(meterState(rolledOver, 'session', NOW)).toMatchObject({ used: 0, reset: true })
    expect(fill(rolledOver, 'used')).toBe(0)
    expect(fill(rolledOver, 'remaining')).toBe(100)
  })

  it('stays empty without a window in either mode', () => {
    expect(fill(null, 'used')).toBe(0)
    expect(fill(null, 'remaining')).toBe(0)
  })
})

describe('ringWindow', () => {
  const HOUR = 3_600_000
  // Two of five hours passed.
  const window = { usedPercentage: 30, resetsAt: NOW + 3 * HOUR }

  it('uses the account colour while calm and the risk token otherwise', () => {
    expect(ringWindow(window, 'fiveHour', NOW, 'used', '#123456').color).toBe('#123456')
    const hot = { usedPercentage: 90, resetsAt: NOW + 3 * HOUR }
    expect(ringWindow(hot, 'fiveHour', NOW, 'used', '#123456').color).toBe('var(--danger)')
  })

  it('places the tick by display mode', () => {
    expect(ringWindow(window, 'fiveHour', NOW, 'used', '#000').marker).toBeCloseTo(0.4)
    expect(ringWindow(window, 'fiveHour', NOW, 'remaining', '#000').marker).toBeCloseTo(0.6)
  })

  it('drops the tick when the window rolled over or is missing', () => {
    expect(ringWindow(rolledOver, 'fiveHour', NOW, 'used', '#000')).toMatchObject({
      marker: null,
      fill: 0,
      active: true
    })
    expect(ringWindow(null, 'sevenDay', NOW, 'used', '#000')).toMatchObject({
      marker: null,
      fill: 0,
      active: false
    })
  })
})
