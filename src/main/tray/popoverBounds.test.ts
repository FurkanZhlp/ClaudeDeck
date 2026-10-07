import { describe, expect, it } from 'vitest'
import { popoverBounds } from './popoverBounds'

const SIZE = { width: 360, height: 560 }
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 }

describe('popoverBounds', () => {
  it('centres the popover under the icon', () => {
    const tray = { x: 1000, y: 0, width: 40, height: 24 }
    expect(popoverBounds(tray, WORK_AREA, SIZE)).toEqual({ x: 840, y: 31, width: 360, height: 560 })
  })

  it('keeps it inside the right edge of the work area', () => {
    const tray = { x: 1420, y: 0, width: 20, height: 24 }
    expect(popoverBounds(tray, WORK_AREA, SIZE).x).toBe(1440 - 360 - 6)
  })

  it('keeps it inside the left edge on a secondary display', () => {
    const area = { x: -1920, y: 25, width: 1920, height: 1055 }
    const tray = { x: -1910, y: 0, width: 20, height: 24 }
    expect(popoverBounds(tray, area, SIZE).x).toBe(-1914)
  })

  it('shortens it on a small screen', () => {
    const area = { x: 0, y: 25, width: 1024, height: 500 }
    const tray = { x: 500, y: 0, width: 30, height: 24 }
    expect(popoverBounds(tray, area, SIZE).height).toBe(25 + 500 - 31 - 6)
  })
})
