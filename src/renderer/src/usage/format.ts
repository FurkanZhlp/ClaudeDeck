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

export { formatPercent } from '@shared/usageDisplay'

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

/** "$65.13" below a thousand, "$13.3K" above, so the cost total stays short. */
// Turkish compact thousands ("10,5 B") read like billions, so Turkish shows whole dollars instead.
const compactCost = (usd: number, language: string): boolean =>
  usd >= 1000 && !language.toLowerCase().startsWith('tr')

export function formatCost(
  usd: number,
  language: string,
  compact = compactCost(usd, language)
): string {
  const whole = !compact && usd >= 1000
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    minimumFractionDigits: compact || whole ? 0 : 2,
    maximumFractionDigits: compact ? 1 : whole ? 0 : 2
  }).format(usd)
}

/** "171.9M", "1.2B" in English, "171,9 Mn" in Turkish. */
export const formatTokens = (count: number, language: string): string =>
  new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(count)

/** "9 Oct" / "9 Eki". */
export const formatDay = (time: number, language: string): string =>
  new Date(time).toLocaleDateString(language, { day: 'numeric', month: 'short' })
