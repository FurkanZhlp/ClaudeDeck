import type { AccountStats, TokenBreakdown } from '@shared/types'

export type CostRange = 'today' | 'week' | 'month'

export const COST_RANGES: readonly CostRange[] = ['today', 'week', 'month']

/** Calendar days each range covers, today included; statistics hold the last 30. */
const RANGE_DAYS: Record<CostRange, number> = { today: 1, week: 7, month: 30 }

/** The trend line needs a few points, so a single day is drawn against its week. */
const MIN_TREND_DAYS = 7

export interface Totals {
  costUSD: number
  tokens: number
}

export interface DayTotal extends Totals {
  date: string
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

/** Cost and tokens per day summed over accounts, for the `days` days ending today, oldest first. */
export function dailyTotals(stats: AccountStats[], days: number, now: number): DayTotal[] {
  const byDay = new Map<string, Totals>()
  for (const account of stats) {
    for (const day of account.days) {
      const sum = byDay.get(day.date) ?? { costUSD: 0, tokens: 0 }
      byDay.set(day.date, {
        costUSD: sum.costUSD + day.costUSD,
        tokens: sum.tokens + totalTokens(day.tokens)
      })
    }
  }
  return Array.from({ length: days }, (_, index) => {
    const date = dayKey(now, index - days + 1)
    return { date, ...(byDay.get(date) ?? { costUSD: 0, tokens: 0 }) }
  })
}

/** Days drawn by the trend line for a range. */
export const trendDays = (range: CostRange): number => Math.max(MIN_TREND_DAYS, RANGE_DAYS[range])

/** Totals over every account for a range. */
export function rangeTotals(stats: AccountStats[], range: CostRange, now: number): Totals {
  return dailyTotals(stats, RANGE_DAYS[range], now).reduce<Totals>(
    (sum, day) => ({ costUSD: sum.costUSD + day.costUSD, tokens: sum.tokens + day.tokens }),
    { costUSD: 0, tokens: 0 }
  )
}
