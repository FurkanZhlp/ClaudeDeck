import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccountUsage } from '../../shared/types'
import { createUsageStore, parseStatuslineUsage } from './usageStore'

const storeFile = (): string =>
  join(mkdtempSync(join(tmpdir(), 'claudedeck-usage-store-')), 'usage.json')

const usage = (accountId: string, updatedAt: number, used = 10): AccountUsage => ({
  accountId,
  fiveHour: { usedPercentage: used, resetsAt: 1_000_000 },
  sevenDay: null,
  updatedAt
})

describe('parseStatuslineUsage', () => {
  it('converts seconds to ms and keeps both windows', () => {
    const json = {
      rate_limits: {
        five_hour: { used_percentage: 29, resets_at: 1791329400 },
        seven_day: { used_percentage: 60.5, resets_at: 1791507600 }
      }
    }
    expect(parseStatuslineUsage(json, 'a', 42)).toEqual({
      accountId: 'a',
      fiveHour: { usedPercentage: 29, resetsAt: 1791329400000 },
      sevenDay: { usedPercentage: 60.5, resetsAt: 1791507600000 },
      updatedAt: 42
    })
  })

  it('clamps percentages', () => {
    const json = {
      rate_limits: {
        five_hour: { used_percentage: 140, resets_at: 1 },
        seven_day: { used_percentage: -3, resets_at: 2 }
      }
    }
    const result = parseStatuslineUsage(json, 'a', 0)
    expect(result?.fiveHour?.usedPercentage).toBe(100)
    expect(result?.sevenDay?.usedPercentage).toBe(0)
  })

  it('keeps a partial reading and drops malformed windows', () => {
    const json = {
      rate_limits: {
        five_hour: { used_percentage: '29', resets_at: 1 },
        seven_day: { used_percentage: 5, resets_at: 1791507600 }
      }
    }
    expect(parseStatuslineUsage(json, 'a', 0)).toMatchObject({
      fiveHour: null,
      sevenDay: { usedPercentage: 5 }
    })
    expect(
      parseStatuslineUsage(
        { rate_limits: { five_hour: { used_percentage: 1, resets_at: 9 } } },
        'a',
        0
      )
    ).toMatchObject({ fiveHour: { resetsAt: 9000 }, sevenDay: null })
  })

  it('returns null without usable windows', () => {
    expect(parseStatuslineUsage({ session_id: 'x' }, 'a', 0)).toBeNull()
    expect(parseStatuslineUsage({ rate_limits: {} }, 'a', 0)).toBeNull()
    expect(parseStatuslineUsage({ rate_limits: { five_hour: null } }, 'a', 0)).toBeNull()
    expect(parseStatuslineUsage({ rate_limits: [] }, 'a', 0)).toBeNull()
    expect(parseStatuslineUsage(null, 'a', 0)).toBeNull()
    expect(parseStatuslineUsage('text', 'a', 0)).toBeNull()
    expect(
      parseStatuslineUsage(
        { rate_limits: { five_hour: { used_percentage: NaN, resets_at: 1 } } },
        'a',
        0
      )
    ).toBeNull()
  })
})

describe('createUsageStore', () => {
  it('replaces older readings only', () => {
    const store = createUsageStore(storeFile())
    expect(store.update(usage('a', 10))).toBe(true)
    expect(store.update(usage('a', 5, 50))).toBe(false)
    expect(store.update(usage('a', 10))).toBe(false)
    expect(store.update(usage('a', 20, 30))).toBe(true)
    expect(store.get('a')?.fiveHour?.usedPercentage).toBe(30)
  })

  it('persists across instances', () => {
    const file = storeFile()
    const store = createUsageStore(file)
    store.update(usage('a', 10))
    store.update(usage('b', 11))
    expect(createUsageStore(file).list()).toEqual([usage('a', 10), usage('b', 11)])
  })

  it('forgets removed accounts', () => {
    const file = storeFile()
    const store = createUsageStore(file)
    store.update(usage('a', 10))
    store.update(usage('b', 11))
    store.retain(['b'])
    expect(store.list().map((u) => u.accountId)).toEqual(['b'])
    expect(createUsageStore(file).get('a')).toBeNull()
  })

  it('survives a corrupt or foreign file', () => {
    const file = storeFile()
    writeFileSync(file, '{ nope')
    expect(createUsageStore(file).list()).toEqual([])
    writeFileSync(file, JSON.stringify({ accounts: [{ accountId: 1 }, usage('a', 1)] }))
    const store = createUsageStore(file)
    expect(store.list()).toEqual([usage('a', 1)])
    store.update(usage('a', 2))
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toEqual([usage('a', 2)])
  })
})
