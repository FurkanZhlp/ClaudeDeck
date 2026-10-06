import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountStats, DailyUsage } from '../../shared/types'
import { createPricing } from './pricing'
import { createStatsScanner, localDay } from './scanner'

const pricing = createPricing({
  'claude-test-1': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_creation_input_token_cost: 3e-6,
    cache_read_input_token_cost: 4e-6
  }
})

// Local wall clock times, so day grouping is checked against the machine's own zone.
const NOW = new Date(2026, 9, 7, 12, 0).getTime()
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 9, day, hour, minute).toISOString()

interface LineOptions {
  ts: string
  id?: string
  req?: string
  model?: string | null
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  costUSD?: number
}

const line = (o: LineOptions): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: o.ts,
    requestId: o.req,
    ...(o.costUSD !== undefined ? { costUSD: o.costUSD } : {}),
    message: {
      id: o.id,
      ...(o.model === null ? {} : { model: o.model ?? 'claude-test-1' }),
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0
      }
    }
  })

let dir: string

const write = (rel: string, lines: string[]): string => {
  const file = join(dir, 'projects', rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const dayOf = (stats: AccountStats, date: string): DailyUsage | undefined =>
  stats.days.find((d) => d.date === date)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-stats-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scanAccountStats', () => {
  it('returns every day of the window, oldest first, even without logs', async () => {
    const stats = await createStatsScanner({ pricing }).scan(dir, 'a1', NOW)
    expect(stats.accountId).toBe('a1')
    expect(stats.days).toHaveLength(30)
    expect(stats.days[0].date).toBe('2026-09-08')
    expect(stats.days[29].date).toBe('2026-10-07')
    expect(stats.days.every((d) => d.costUSD === 0 && d.tokens.input === 0)).toBe(true)
  })

  it('prices tokens with model rates and sums all buckets', async () => {
    write('p/s.jsonl', [
      line({
        ts: at(7, 9),
        id: 'm1',
        req: 'r1',
        input: 100,
        output: 10,
        cacheWrite: 5,
        cacheRead: 2
      })
    ])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.tokens).toEqual({ input: 100, output: 10, cacheWrite: 5, cacheRead: 2 })
    expect(day?.costUSD).toBeCloseTo(100e-6 + 20e-6 + 15e-6 + 8e-6, 12)
  })

  it('keeps the first of duplicated (message.id, requestId) in path order', async () => {
    write('b/later.jsonl', [line({ ts: at(7, 9), id: 'm1', req: 'r1', input: 999 })])
    write('a/first.jsonl', [
      line({ ts: at(7, 9), id: 'm1', req: 'r1', input: 100 }),
      line({ ts: at(7, 9), id: 'm1', req: 'r1', input: 100 }),
      // Same message under another request, and a line without ids: both counted.
      line({ ts: at(7, 9), id: 'm1', req: 'r2', input: 10 }),
      line({ ts: at(7, 9), input: 1 })
    ])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.tokens.input).toBe(111)
  })

  it('prefers a line costUSD over model rates', async () => {
    write('p/s.jsonl', [line({ ts: at(7, 9), id: 'm', req: 'r', input: 1000, costUSD: 1.5 })])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.costUSD).toBe(1.5)
  })

  it('counts tokens at no cost for synthetic, missing and unknown models', async () => {
    write('p/s.jsonl', [
      line({ ts: at(7, 9), id: 'a', req: 'r', input: 10, model: '<synthetic>' }),
      line({ ts: at(7, 9), id: 'b', req: 'r', input: 20, model: null }),
      line({ ts: at(7, 9), id: 'c', req: 'r', input: 30, model: 'gpt-5' })
    ])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.tokens.input).toBe(60)
    expect(day?.costUSD).toBe(0)
  })

  it('groups by local calendar day across midnight', async () => {
    write('p/s.jsonl', [
      line({ ts: at(5, 23, 59), id: 'a', req: 'r', input: 1 }),
      line({ ts: at(6, 0, 1), id: 'b', req: 'r', input: 2 })
    ])
    const stats = await createStatsScanner({ pricing }).scan(dir, 'a1', NOW)
    expect(dayOf(stats, '2026-10-05')?.tokens.input).toBe(1)
    expect(dayOf(stats, '2026-10-06')?.tokens.input).toBe(2)
    expect(localDay(Date.parse(at(5, 23, 59)))).toBe('2026-10-05')
  })

  it('ignores entries before the window and files not touched within it', async () => {
    write('p/s.jsonl', [
      line({ ts: at(7, 9), id: 'a', req: 'r', input: 1 }),
      line({ ts: new Date(2026, 8, 7, 23).toISOString(), id: 'b', req: 'r', input: 50 })
    ])
    const stale = write('p/old.jsonl', [line({ ts: at(7, 9), id: 'c', req: 'r', input: 500 })])
    const old = new Date(2026, 7, 1)
    utimesSync(stale, old, old)
    const stats = await createStatsScanner({ pricing }).scan(dir, 'a1', NOW)
    const total = stats.days.reduce((sum, d) => sum + d.tokens.input, 0)
    expect(total).toBe(1)
  })

  it('skips malformed lines without failing the file', async () => {
    write('p/s.jsonl', [
      '{"usage":{ not json',
      JSON.stringify({
        timestamp: 'nope',
        message: { usage: { input_tokens: 5, output_tokens: 0 } }
      }),
      JSON.stringify({ timestamp: at(7, 9), message: { usage: { input_tokens: 'x' } } }),
      JSON.stringify({
        timestamp: at(7, 9),
        message: { usage: { input_tokens: 7, output_tokens: 1 } }
      }),
      '',
      'plain text'
    ])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.tokens).toEqual({ input: 7, output: 1, cacheWrite: 0, cacheRead: 0 })
  })

  it('reads nested session files such as subagent logs', async () => {
    write('p/session/subagents/agent-1.jsonl', [
      line({ ts: at(7, 9), id: 'a', req: 'r', input: 3 })
    ])
    const day = dayOf(await createStatsScanner({ pricing }).scan(dir, 'a1', NOW), '2026-10-07')
    expect(day?.tokens.input).toBe(3)
  })

  it('reparses only changed or new files on a rescan', async () => {
    const parsed: string[] = []
    const scanner = createStatsScanner({ pricing, onParse: (p) => parsed.push(p) })
    const a = write('p/a.jsonl', [line({ ts: at(7, 9), id: 'a', req: 'r', input: 1 })])
    const b = write('p/b.jsonl', [line({ ts: at(7, 9), id: 'b', req: 'r', input: 2 })])
    await scanner.scan(dir, 'a1', NOW)
    expect(parsed.sort()).toEqual([a, b].sort())

    parsed.length = 0
    await scanner.scan(dir, 'a1', NOW)
    expect(parsed).toEqual([])

    appendFileSync(b, line({ ts: at(7, 10), id: 'b2', req: 'r', input: 4 }) + '\n')
    const c = write('p/c.jsonl', [line({ ts: at(7, 9), id: 'c', req: 'r', input: 8 })])
    const stats = await scanner.scan(dir, 'a1', NOW)
    expect(parsed.sort()).toEqual([b, c].sort())
    expect(dayOf(stats, '2026-10-07')?.tokens.input).toBe(15)
  })
})
