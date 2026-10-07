import { motion, useReducedMotion } from 'motion/react'
import { useId, type ReactNode } from 'react'
import type { RingWindow } from './meter'
import {
  arcDashOffset,
  arcLength,
  circumference,
  markerSegment,
  ringGeometry,
  type RingTrack
} from './ring'
import { sparklinePath, sparklinePoints } from './sparkline'

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const ARC_S = 0.4
/** The tick appears once the arcs have mostly drawn. */
const MARKER_DELAY_S = 0.28

/** A faint wash of a colour, for ring tracks and the sparkline area. */
const tint = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`

const TRACK_TINT = 22
/** Below this size the now tick would crowd the ring, so tiny rings leave it out. */
const MIN_MARKER_SIZE = 40
const EMPTY_TRACK = tint('var(--fg)', 8)

/**
 * Two concentric usage rings: weekly outside, the five hour session inside. Each carries a
 * small tick at the time already gone in its window, so an arc running past its tick reads as
 * ahead of pace at a glance.
 */
export function UsageRings({
  size,
  session,
  weekly,
  accountColor,
  label,
  tooltip,
  surface = 'var(--elevated)',
  children
}: {
  size: number
  session: RingWindow
  weekly: RingWindow
  /** Track colour; arcs carry their own (account colour or risk token). */
  accountColor: string
  /** Accessible summary with the values. */
  label: string
  tooltip?: string
  /** Background behind the ring; the tick is outlined with it so it reads on any arc colour. */
  surface?: string
  children?: ReactNode
}): React.JSX.Element {
  const geometry = ringGeometry(size)
  const tickWidth = Math.max(1.25, size * 0.02)

  return (
    <div
      role="img"
      aria-label={label}
      data-tooltip={tooltip}
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {[
          { window: weekly, track: geometry.outer },
          { window: session, track: geometry.inner }
        ].map(({ window, track }) => (
          <Ring
            key={window.kind}
            window={window}
            track={track}
            center={geometry.center}
            trackColor={window.active ? tint(accountColor, TRACK_TINT) : EMPTY_TRACK}
          />
        ))}
        {[
          { window: weekly, track: geometry.outer },
          { window: session, track: geometry.inner }
        ].map(({ window, track }) =>
          window.marker === null || size < MIN_MARKER_SIZE ? null : (
            <Marker
              key={window.kind}
              fraction={window.marker}
              track={track}
              center={geometry.center}
              overhang={geometry.overhang}
              width={tickWidth}
              surface={surface}
            />
          )
        )}
      </svg>
      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      )}
    </div>
  )
}

function Ring({
  window,
  track,
  center,
  trackColor
}: {
  window: RingWindow
  track: RingTrack
  center: number
  trackColor: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const full = circumference(track.radius)
  const length = arcLength(window.fill / 100, track.radius, track.stroke)
  const offset = arcDashOffset(window.fill / 100, track.stroke)

  return (
    <g transform={`rotate(-90 ${center} ${center})`}>
      <circle
        cx={center}
        cy={center}
        r={track.radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={track.stroke}
      />
      <motion.circle
        cx={center}
        cy={center}
        r={track.radius}
        fill="none"
        strokeWidth={track.stroke}
        strokeLinecap="round"
        style={{ transition: 'stroke 300ms ease-out' }}
        stroke={window.color}
        initial={
          reduced
            ? false
            : {
                strokeDasharray: `0 ${full}`,
                strokeDashoffset: offset,
                opacity: length > 0 ? 1 : 0
              }
        }
        animate={{
          strokeDasharray: `${length} ${full}`,
          strokeDashoffset: offset,
          opacity: length > 0 ? 1 : 0
        }}
        transition={reduced ? { duration: 0 } : { duration: ARC_S, ease: EASE_OUT }}
      />
    </g>
  )
}

function Marker({
  fraction,
  track,
  center,
  overhang,
  width,
  surface
}: {
  fraction: number
  track: RingTrack
  center: number
  overhang: number
  width: number
  surface: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const { from, to } = markerSegment(center, track, overhang, fraction)
  const line = { x1: from.x, y1: from.y, x2: to.x, y2: to.y, strokeLinecap: 'round' as const }

  return (
    <motion.g
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduced ? { duration: 0 } : { duration: 0.2, delay: MARKER_DELAY_S }}
    >
      <line {...line} stroke={surface} strokeWidth={width + 2} />
      <line {...line} stroke="var(--fg)" strokeWidth={width} />
    </motion.g>
  )
}

export interface SparkPoint {
  key: string
  value: number
  tooltip: string
}

const SPARK_W = 300
const SPARK_H = 32
const SPARK_INSET = 3

/**
 * Thin daily line with a soft area under it; the last point (today) gets a dot. Each day has
 * a hover column with its own tooltip.
 */
export function Sparkline({
  points,
  color,
  label
}: {
  points: SparkPoint[]
  color: string
  label: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const clipId = useId()
  const coords = sparklinePoints(
    points.map((p) => p.value),
    SPARK_W,
    SPARK_H,
    SPARK_INSET
  )
  const last = coords[coords.length - 1]

  return (
    <div role="img" aria-label={label} className="relative h-8 w-full">
      <svg
        className="absolute inset-0 size-full overflow-visible"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <clipPath id={clipId}>
            <motion.rect
              x={0}
              y={-SPARK_H}
              height={SPARK_H * 3}
              initial={{ width: reduced ? SPARK_W : 0 }}
              animate={{ width: SPARK_W }}
              transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE_OUT }}
            />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <path d={sparklinePath(coords, SPARK_H)} fill={tint(color, 12)} />
          <path
            d={sparklinePath(coords)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
      {last && (
        <span
          aria-hidden
          className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-elevated"
          style={{
            left: `${(last.x / SPARK_W) * 100}%`,
            top: `${(last.y / SPARK_H) * 100}%`,
            background: color
          }}
        />
      )}
      <div className="absolute inset-0 flex">
        {points.map((point) => (
          <span
            key={point.key}
            data-tooltip={point.tooltip}
            className="h-full min-w-0 flex-1 rounded-sm hover:bg-fg/[0.05]"
          />
        ))}
      </div>
    </div>
  )
}
