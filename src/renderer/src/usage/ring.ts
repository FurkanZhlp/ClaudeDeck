import type { UsageDisplay, UsageWindow } from '@shared/types'
import { PERIOD_MS, isReset, type UsageWindowKind } from '@shared/usagePace'

/*
 * Geometry of the usage rings: two concentric arcs (outer weekly, inner five hour session)
 * plus a "now" tick per ring at the share of the window that already passed.
 * Angles start at 12 o'clock and run clockwise; fractions are 0-1.
 */

export interface RingTrack {
  radius: number
  stroke: number
}

export interface RingGeometry {
  size: number
  center: number
  outer: RingTrack
  inner: RingTrack
  /** How far the now tick reaches past the stroke on each side. */
  overhang: number
}

/** Stroke as a share of the ring size, and its floor so tiny rings stay legible. */
const STROKE_RATIO = 0.075
const MIN_STROKE = 3
/** Space between the two rings, as a share of the stroke. */
const GAP_RATIO = 0.45
const MIN_GAP = 2.5
const MIN_OVERHANG = 1
const OVERHANG_RATIO = 0.012

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

export function ringGeometry(size: number): RingGeometry {
  const stroke = Math.max(MIN_STROKE, size * STROKE_RATIO)
  const gap = Math.max(MIN_GAP, stroke * GAP_RATIO)
  const overhang = Math.max(MIN_OVERHANG, size * OVERHANG_RATIO)
  const center = size / 2
  const outerRadius = center - overhang - stroke / 2
  return {
    size,
    center,
    overhang,
    outer: { radius: outerRadius, stroke },
    inner: { radius: outerRadius - stroke - gap, stroke }
  }
}

export const circumference = (radius: number): number => 2 * Math.PI * radius

/**
 * Dash length for a filled share of the ring. A round cap paints half a stroke past each end
 * of the dash, so a partial dash is one stroke shorter than the arc and is shifted forward by
 * half a stroke (`arcDashOffset`); the painted ink then starts at 12 o'clock and ends exactly
 * at the share. A sliver still shows as a dot. Empty draws nothing, full closes the ring.
 */
export function arcLength(fraction: number, radius: number, stroke: number): number {
  const share = clamp01(fraction)
  const full = circumference(radius)
  if (share <= 0) return 0
  if (share >= 1) return full
  return Math.max(0.001, share * full - stroke)
}

/** `stroke-dashoffset` that pairs with `arcLength`: half a stroke forward for partial arcs. */
export function arcDashOffset(fraction: number, stroke: number): number {
  const share = clamp01(fraction)
  return share > 0 && share < 1 ? -stroke / 2 : 0
}

/** Where the painted ink of an arc starts and ends along the ring, caps included. */
export function arcInkSpan(
  fraction: number,
  radius: number,
  stroke: number
): { start: number; end: number } | null {
  const length = arcLength(fraction, radius, stroke)
  if (length <= 0) return null
  if (length >= circumference(radius)) return { start: 0, end: length }
  const dashStart = -arcDashOffset(fraction, stroke)
  return { start: dashStart - stroke / 2, end: dashStart + length + stroke / 2 }
}

/**
 * Share of the window that already passed, or null when there is no window or it rolled
 * over since the last report (the tick would point at a period that is over).
 */
export function elapsedFraction(
  window: UsageWindow | null,
  kind: UsageWindowKind,
  now: number
): number | null {
  if (!window || isReset(window, now)) return null
  const period = PERIOD_MS[kind]
  return clamp01(1 - (window.resetsAt - now) / period)
}

/**
 * Where the tick sits for the display mode: elapsed time next to used share, time left next
 * to the remaining share. Either way an arc ahead of its tick means usage outpaces the clock
 * (used) or budget is left over (remaining).
 */
export const markerFraction = (elapsed: number, display: UsageDisplay): number =>
  display === 'used' ? clamp01(elapsed) : clamp01(1 - elapsed)

export interface Point {
  x: number
  y: number
}

/** Point on a circle at a share of a full turn, 0 at 12 o'clock, clockwise. */
export function polar(center: number, radius: number, fraction: number): Point {
  const angle = fraction * 2 * Math.PI - Math.PI / 2
  return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }
}

/** Radial tick across a track at a share of a full turn. */
export function markerSegment(
  center: number,
  track: RingTrack,
  overhang: number,
  fraction: number
): { from: Point; to: Point } {
  const reach = track.stroke / 2 + overhang
  return {
    from: polar(center, track.radius - reach, fraction),
    to: polar(center, track.radius + reach, fraction)
  }
}

/** The window with the highest used share among those that have data; ties favour the first. */
export function mostCritical<K extends string>(
  windows: ReadonlyArray<{ kind: K; used: number | null }>
): K | null {
  let best: { kind: K; used: number } | null = null
  for (const { kind, used } of windows) {
    if (used === null) continue
    if (!best || used > best.used) best = { kind, used }
  }
  return best?.kind ?? null
}
