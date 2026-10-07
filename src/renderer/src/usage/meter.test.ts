import { describe, expect, it } from 'vitest'
import { meterFill, meterState } from './meter'

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
