import type { TFunction } from 'i18next'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Compact duration with at most two units: "3 g 4 sa", "2 sa 10 dk", "12 dk".
 * Units come from the locale files; Intl's narrow units are not readable in Turkish.
 */
export function formatDuration(ms: number, t: TFunction): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS))
  const days = Math.floor(minutes / (DAY_MS / MINUTE_MS))
  const hours = Math.floor((minutes % (DAY_MS / MINUTE_MS)) / 60)
  const rest = minutes % 60
  const unit = (key: 'day' | 'hour' | 'minute', count: number): string =>
    t(`usage.unit.${key}`, { count })

  if (days > 0) return hours > 0 ? `${unit('day', days)} ${unit('hour', hours)}` : unit('day', days)
  if (hours > 0)
    return rest > 0 ? `${unit('hour', hours)} ${unit('minute', rest)}` : unit('hour', hours)
  return unit('minute', rest)
}

/** "%62" in Turkish, "62%" in English. */
export const formatPercent = (value: number, language: string): string =>
  new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(
    value / 100
  )

/** Local reset time; a weekday is added when it is not within the next day. */
export function formatResetAt(resetsAt: number, language: string, now: number): string {
  const withDay =
    resetsAt - now >= DAY_MS || new Date(resetsAt).getDate() !== new Date(now).getDate()
  return new Date(resetsAt).toLocaleString(language, {
    weekday: withDay ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit'
  })
}
