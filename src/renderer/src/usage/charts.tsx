import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

const EASE_OUT = [0.22, 1, 0.36, 1] as const

export interface DonutSegment {
  id: string
  color: string
  value: number
}

const DONUT_SIZE = 128
const DONUT_STROKE = 14
/** Gap between neighbouring segments, in pixels along the ring. */
const SEGMENT_GAP = 2

/** Ring chart drawn with one dashed circle per segment; segments sweep in on mount. */
export function Donut({
  segments,
  label,
  children
}: {
  segments: DonutSegment[]
  /** Accessible summary of the whole chart. */
  label: string
  /** Centre content, e.g. the total. */
  children: ReactNode
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const radius = (DONUT_SIZE - DONUT_STROKE) / 2
  const circumference = 2 * Math.PI * radius
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
  const visible = segments.filter((s) => s.value > 0)
  const gap = visible.length > 1 ? SEGMENT_GAP : 0

  const lengths = visible.map((segment) =>
    total > 0 ? (segment.value / total) * circumference : 0
  )
  const arcs = visible.map((segment, index) => ({
    ...segment,
    start: lengths.slice(0, index).reduce((sum, length) => sum + length, 0),
    length: Math.max(0.5, lengths[index] - gap)
  }))

  return (
    <div
      role="img"
      aria-label={label}
      className="relative shrink-0"
      style={{ width: DONUT_SIZE, height: DONUT_SIZE }}
    >
      <svg
        width={DONUT_SIZE}
        height={DONUT_SIZE}
        viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={DONUT_SIZE / 2}
          cy={DONUT_SIZE / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={DONUT_STROKE}
          className="text-fg/[0.07]"
        />
        {arcs.map((arc, index) => (
          <motion.circle
            key={arc.id}
            cx={DONUT_SIZE / 2}
            cy={DONUT_SIZE / 2}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={DONUT_STROKE}
            initial={{ strokeDasharray: `0 ${circumference}`, strokeDashoffset: -arc.start }}
            animate={{
              strokeDasharray: `${arc.length} ${circumference - arc.length}`,
              strokeDashoffset: -arc.start
            }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 0.7, ease: EASE_OUT, delay: 0.08 + index * 0.06 }
            }
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  )
}

export interface TrendBar {
  key: string
  value: number
  tooltip: string
  highlight: boolean
}

/** Tiny bar sparkline; bars grow from the baseline with a short stagger. */
export function TrendBars({
  bars,
  color,
  label
}: {
  bars: TrendBar[]
  color: string
  label: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const max = Math.max(0, ...bars.map((bar) => bar.value))

  return (
    <div role="img" aria-label={label} className="flex h-10 items-end gap-[2px]">
      {bars.map((bar, index) => {
        const ratio = max > 0 ? bar.value / max : 0
        return (
          <span
            key={bar.key}
            data-tooltip={bar.tooltip}
            className="flex h-full min-w-0 flex-1 items-end rounded-[2px] hover:bg-fg/[0.06]"
          >
            {ratio > 0 ? (
              <motion.span
                className="block w-full origin-bottom rounded-[2px]"
                style={{
                  height: `${Math.max(6, ratio * 100)}%`,
                  background: color,
                  opacity: bar.highlight ? 1 : 0.55
                }}
                initial={{ scaleY: reduced ? 1 : 0 }}
                animate={{ scaleY: 1 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.45, ease: EASE_OUT, delay: index * 0.012 }
                }
              />
            ) : (
              <span className="block h-px w-full bg-fg/15" />
            )}
          </span>
        )
      })}
    </div>
  )
}
