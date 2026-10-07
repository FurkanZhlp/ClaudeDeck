import type { Point } from './ring'

/**
 * Points of a sparkline in a width x height box. Each value sits in the middle of its own
 * equal-width column, so hover columns laid over the chart line up with their points. Zero is
 * on the baseline and the peak at the top; `inset` keeps the stroke and the end dot inside.
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  inset: number
): Point[] {
  if (values.length === 0) return []
  const peak = Math.max(0, ...values)
  const column = width / values.length
  const bottom = height - inset
  const range = height - inset * 2
  return values.map((value, index) => ({
    x: (index + 0.5) * column,
    y: peak > 0 ? bottom - (Math.max(0, value) / peak) * range : bottom
  }))
}

const round = (n: number): number => Math.round(n * 100) / 100

/** SVG path through the points; `closeTo` closes it along that baseline for the area fill. */
export function sparklinePath(points: readonly Point[], closeTo?: number): string {
  if (points.length === 0) return ''
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ')
  if (closeTo === undefined) return line
  const first = points[0]
  const last = points[points.length - 1]
  return `${line} L${round(last.x)} ${round(closeTo)} L${round(first.x)} ${round(closeTo)} Z`
}
