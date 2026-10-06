import { describe, expect, it } from 'vitest'
import {
  FIVE_HOUR_MS,
  parseResetsAt,
  parseUsageCommandOutput,
  usageResultText
} from './usageCommand'

const SAMPLE =
  'You are currently using your subscription to power your Claude Code usage\n\n' +
  'Current session: 1% used · resets Oct 7 at 7:30am (Europe/Istanbul)\n' +
  'Current week (all models): 62% used · resets Oct 9 at 4am (Europe/Istanbul)\n' +
  'Current week (Fable): 0% used · resets Oct 9 at 4am (Europe/Istanbul)'

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi)

describe('parseUsageCommandOutput', () => {
  it('parses the real /usage output', () => {
    const now = utc(2026, 10, 7, 3)
    expect(parseUsageCommandOutput(SAMPLE, 'a', now)).toEqual({
      accountId: 'a',
      // 7:30 in Istanbul (UTC+3) is 4:30 UTC.
      fiveHour: { usedPercentage: 1, resetsAt: utc(2026, 10, 7, 4, 30) },
      sevenDay: { usedPercentage: 62, resetsAt: utc(2026, 10, 9, 1) },
      models: [{ model: 'Fable', usedPercentage: 0, resetsAt: utc(2026, 10, 9, 1) }],
      updatedAt: now
    })
  })

  it('collects every per-model weekly line', () => {
    const now = utc(2026, 10, 7, 3)
    const text =
      'Current week (all models): 50% used · resets Oct 9 at 4am (UTC)\n' +
      'Current week (Fable): 20% used · resets Oct 9 at 4am (UTC)\n' +
      'Current week (Opus): 7% used'
    expect(parseUsageCommandOutput(text, 'a', now)?.models).toEqual([
      { model: 'Fable', usedPercentage: 20, resetsAt: utc(2026, 10, 9, 4) },
      { model: 'Opus', usedPercentage: 7, resetsAt: now + 7 * 24 * 3_600_000 }
    ])
  })

  it('needs a session or all-models line besides per-model lines', () => {
    const text = 'Current week (Fable): 90% used · resets Oct 9 at 4am (Europe/Istanbul)'
    expect(parseUsageCommandOutput(text, 'a', utc(2026, 10, 7))).toBeNull()
  })

  it('keeps a window with an estimated reset when the reset is unreadable', () => {
    const now = utc(2026, 10, 7, 3)
    const usage = parseUsageCommandOutput('Current session: 40% used · resets soon', 'a', now)
    expect(usage).toEqual({
      accountId: 'a',
      fiveHour: { usedPercentage: 40, resetsAt: now + FIVE_HOUR_MS },
      sevenDay: null,
      models: [],
      updatedAt: now
    })
  })

  it('clamps percentages', () => {
    const usage = parseUsageCommandOutput('Current week: 130% used', 'a', 0)
    expect(usage?.sevenDay?.usedPercentage).toBe(100)
  })

  it('returns null for API key accounts and garbage', () => {
    const api =
      'You are currently using API usage billing. Usage limits do not apply to API key accounts.'
    expect(parseUsageCommandOutput(api, 'a', 0)).toBeNull()
    expect(parseUsageCommandOutput('', 'a', 0)).toBeNull()
    expect(parseUsageCommandOutput('Current session: lots used', 'a', 0)).toBeNull()
    expect(parseUsageCommandOutput('{"weird": true}', 'a', 0)).toBeNull()
  })
})

describe('parseResetsAt', () => {
  const istanbul = (s: string): string => `resets ${s} (Europe/Istanbul)`

  it('handles 12am and 12pm', () => {
    const now = utc(2026, 10, 7, 3)
    expect(parseResetsAt(istanbul('Oct 8 at 12am'), now)).toBe(utc(2026, 10, 7, 21))
    expect(parseResetsAt(istanbul('Oct 8 at 12:15am'), now)).toBe(utc(2026, 10, 7, 21, 15))
    expect(parseResetsAt(istanbul('Oct 8 at 12pm'), now)).toBe(utc(2026, 10, 8, 9))
    expect(parseResetsAt(istanbul('Oct 8 at 1pm'), now)).toBe(utc(2026, 10, 8, 10))
    expect(parseResetsAt(istanbul('Oct 8 at 13pm'), now)).toBeNull()
  })

  it('follows DST in America/New_York (March)', () => {
    const ny = (s: string): string => `resets ${s} (America/New_York)`
    const now = utc(2026, 3, 1)
    // DST starts on March 8, 2026 at 2am.
    expect(parseResetsAt(ny('Mar 7 at 4am'), now)).toBe(utc(2026, 3, 7, 9))
    expect(parseResetsAt(ny('Mar 8 at 1:30am'), now)).toBe(utc(2026, 3, 8, 6, 30))
    expect(parseResetsAt(ny('Mar 8 at 3:30am'), now)).toBe(utc(2026, 3, 8, 7, 30))
    expect(parseResetsAt(ny('Mar 9 at 4am'), now)).toBe(utc(2026, 3, 9, 8))
  })

  it('follows DST in America/New_York (November)', () => {
    const ny = (s: string): string => `resets ${s} (America/New_York)`
    const now = utc(2026, 10, 25)
    // DST ends on November 1, 2026 at 2am; the repeated hour resolves to its first instance.
    expect(parseResetsAt(ny('Oct 31 at 4am'), now)).toBe(utc(2026, 10, 31, 8))
    expect(parseResetsAt(ny('Nov 1 at 1:30am'), now)).toBe(utc(2026, 11, 1, 5, 30))
    expect(parseResetsAt(ny('Nov 2 at 4am'), now)).toBe(utc(2026, 11, 2, 9))
  })

  it('infers the year across New Year', () => {
    const now = utc(2026, 12, 30, 12)
    expect(parseResetsAt('resets Jan 2 at 4am (UTC)', now)).toBe(utc(2027, 1, 2, 4))
    // Slightly in the past stays in this year.
    expect(parseResetsAt('resets Dec 30 at 1am (UTC)', now)).toBe(utc(2026, 12, 30, 1))
    expect(parseResetsAt('resets Dec 31 at 1am (UTC)', utc(2027, 1, 1, 0, 30))).toBe(
      utc(2026, 12, 31, 1)
    )
  })

  it('accepts a date without a time and a time without a date', () => {
    const now = utc(2026, 10, 7, 3)
    expect(parseResetsAt('resets Oct 9 (UTC)', now)).toBe(utc(2026, 10, 9))
    expect(parseResetsAt(istanbul('7:30am'), now)).toBe(utc(2026, 10, 7, 4, 30))
    expect(parseResetsAt(istanbul('7:30am'), utc(2026, 10, 7, 5))).toBe(utc(2026, 10, 8, 4, 30))
    expect(parseResetsAt('resets 4', now)).toBeNull()
  })

  it('accepts relative resets', () => {
    const now = utc(2026, 10, 7, 3)
    expect(parseResetsAt('resets in 3h 20m', now)).toBe(now + (3 * 60 + 20) * 60_000)
    expect(parseResetsAt('resets in 2 days, 4 hours', now)).toBe(now + (2 * 24 + 4) * 3_600_000)
  })

  it('falls back to the system zone for an unknown zone', () => {
    const at = parseResetsAt('resets Oct 9 at 4am (Mars/Olympus)', utc(2026, 10, 7))
    expect(Number.isFinite(at)).toBe(true)
  })
})

describe('usageResultText', () => {
  const json = JSON.stringify({ type: 'result', is_error: false, result: SAMPLE })

  it('reads the result after shell noise', () => {
    expect(usageResultText(`Welcome back!\n${json}\n`)).toBe(SAMPLE)
  })

  it('reads pretty-printed output', () => {
    expect(usageResultText(JSON.stringify({ result: 'x' }, null, 2))).toBe('x')
  })

  it('returns null for errors and missing output', () => {
    expect(usageResultText(JSON.stringify({ is_error: true, result: 'boom' }))).toBeNull()
    expect(usageResultText('')).toBeNull()
    expect(usageResultText('not json')).toBeNull()
  })
})
