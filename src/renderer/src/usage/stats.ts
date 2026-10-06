import type { AccountStats, TokenBreakdown } from '@shared/types'

export type CostRange = 'today' | 'yesterday' | 'month'

export const COST_RANGES: readonly CostRange[] = ['today', 'yesterday', 'month']

export interface Totals {
  costUSD: number
  tokens: number
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar day as YYYY-MM-DD, the format of `DailyUsage.date`. */
export function dayKey(time: number, offsetDays = 0): string {
  const date = new Date(time)
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Midday of a YYYY-MM-DD key, safe to format without time zone surprises. */
export function dayTime(key: string): number {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day, 12).getTime()
}

export const totalTokens = (tokens: TokenBreakdown): number =>
  tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead

/** Cost and token totals of one account for a range; zero when there are no statistics. */
export function rangeTotals(
  stats: AccountStats | undefined,
  range: CostRange,
  now: number
): Totals {
  if (!stats) return { costUSD: 0, tokens: 0 }
  const key = range === 'today' ? dayKey(now) : range === 'yesterday' ? dayKey(now, -1) : null
  return stats.days
    .filter((day) => key === null || day.date === key)
    .reduce<Totals>(
      (sum, day) => ({
        costUSD: sum.costUSD + day.costUSD,
        tokens: sum.tokens + totalTokens(day.tokens)
      }),
      { costUSD: 0, tokens: 0 }
    )
}
