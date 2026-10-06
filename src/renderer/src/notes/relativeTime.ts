const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]

/** "3 minutes ago" / "3 dakika önce" style text for a past timestamp (ms). */
export function formatRelative(timestamp: number, language: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const seconds = Math.round((timestamp - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'second')
}
