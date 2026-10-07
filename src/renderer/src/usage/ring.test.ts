import { describe, expect, it } from 'vitest'
import { PERIOD_MS } from '@shared/usagePace'
import {
  arcDashOffset,
  arcInkSpan,
  arcLength,
  circumference,
  elapsedFraction,
  markerFraction,
  markerSegment,
  mostCritical,
  polar,
  ringGeometry
} from './ring'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

describe('ringGeometry', () => {
  it('fits both rings and the tick inside the box', () => {
    for (const size of [28, 44, 92]) {
      const g = ringGeometry(size)
      expect(g.center).toBe(size / 2)
      expect(g.outer.radius + g.outer.stroke / 2 + g.overhang).toBeCloseTo(size / 2)
      // The inner ring sits inside the outer one with a gap.
      expect(g.inner.radius + g.inner.stroke / 2).toBeLessThan(g.outer.radius - g.outer.stroke / 2)
      expect(g.inner.radius - g.inner.stroke / 2).toBeGreaterThan(0)
    }
  })

  it('keeps a minimum stroke on small rings', () => {
    expect(ringGeometry(28).outer.stroke).toBe(3)
    expect(ringGeometry(92).outer.stroke).toBeCloseTo(6.9)
  })
})

describe('arcLength', () => {
  const r = 40
  const stroke = 6

  it('draws nothing when empty and closes the ring when full', () => {
    expect(arcLength(0, r, stroke)).toBe(0)
    expect(arcLength(-0.2, r, stroke)).toBe(0)
    expect(arcLength(1, r, stroke)).toBe(circumference(r))
    expect(arcLength(1.4, r, stroke)).toBe(circumference(r))
  })

  it('shortens partial arcs by the round caps', () => {
    expect(arcLength(0.5, r, stroke)).toBeCloseTo(Math.PI * r - stroke)
  })

  it('puts both cap ends on the true angles', () => {
    for (const share of [0.12, 0.5, 0.88]) {
      const span = arcInkSpan(share, r, stroke)
      // Back to angles: ink starts at 12 o'clock and ends at the share of a full turn.
      expect((span!.start / circumference(r)) * 360).toBeCloseTo(0)
      expect((span!.end / circumference(r)) * 360).toBeCloseTo(share * 360)
    }
    expect(arcDashOffset(0.5, stroke)).toBe(-stroke / 2)
    expect(arcDashOffset(1, stroke)).toBe(0)
    expect(arcInkSpan(0, r, stroke)).toBeNull()
  })

  it('keeps a sliver visible as a dot', () => {
    expect(arcLength(0.001, r, stroke)).toBeGreaterThan(0)
  })
})

describe('elapsedFraction', () => {
  it('is the share of the window that passed', () => {
    const window = { usedPercentage: 30, resetsAt: NOW + 3 * HOUR }
    expect(elapsedFraction(window, 'fiveHour', NOW)).toBeCloseTo(0.4)
    const week = { usedPercentage: 30, resetsAt: NOW + PERIOD_MS.sevenDay / 4 }
    expect(elapsedFraction(week, 'sevenDay', NOW)).toBeCloseTo(0.75)
  })

  it('is null without a window or after the reset', () => {
    expect(elapsedFraction(null, 'fiveHour', NOW)).toBeNull()
    expect(elapsedFraction({ usedPercentage: 50, resetsAt: NOW }, 'fiveHour', NOW)).toBeNull()
  })

  it('clamps a reset time beyond the window length', () => {
    const odd = { usedPercentage: 5, resetsAt: NOW + 6 * HOUR }
    expect(elapsedFraction(odd, 'fiveHour', NOW)).toBe(0)
  })
})

describe('markerFraction', () => {
  it('follows elapsed time in used mode and time left in remaining mode', () => {
    expect(markerFraction(0.3, 'used')).toBeCloseTo(0.3)
    expect(markerFraction(0.3, 'remaining')).toBeCloseTo(0.7)
  })
})

describe('polar and markerSegment', () => {
  it('starts at 12 o clock and runs clockwise', () => {
    const top = polar(50, 10, 0)
    expect(top.x).toBeCloseTo(50)
    expect(top.y).toBeCloseTo(40)
    const right = polar(50, 10, 0.25)
    expect(right.x).toBeCloseTo(60)
    expect(right.y).toBeCloseTo(50)
  })

  it('crosses the track radially with the overhang on both sides', () => {
    const { from, to } = markerSegment(50, { radius: 20, stroke: 6 }, 1, 0.5)
    expect(from.x).toBeCloseTo(50)
    expect(from.y).toBeCloseTo(66)
    expect(to.y).toBeCloseTo(74)
  })
})

describe('mostCritical', () => {
  it('picks the highest used share and skips missing windows', () => {
    expect(
      mostCritical([
        { kind: 'fiveHour', used: 88 },
        { kind: 'sevenDay', used: 20 }
      ])
    ).toBe('fiveHour')
    expect(
      mostCritical([
        { kind: 'fiveHour', used: null },
        { kind: 'sevenDay', used: 20 }
      ])
    ).toBe('sevenDay')
    expect(mostCritical([{ kind: 'fiveHour', used: null }])).toBeNull()
  })
})

describe('tick spacing', () => {
  it('keeps the ticks of the two rings from touching across the gap', () => {
    for (const size of [44, 56, 92]) {
      const g = ringGeometry(size)
      const gap = g.outer.radius - g.outer.stroke / 2 - (g.inner.radius + g.inner.stroke / 2)
      expect(g.overhang * 2).toBeLessThan(gap)
    }
  })
})
