import { describe, expect, it } from 'vitest'
import type { Account, AccountUsage } from '../../shared/types'
import { pickTrayAccount, trayTitle } from './trayTitle'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

const account = (id: string): Account => ({ id, name: id, color: '#000', configDir: `/x/${id}` })
const usage = (accountId: string, session: number | null, weekly: number | null): AccountUsage => ({
  accountId,
  fiveHour: session === null ? null : { usedPercentage: session, resetsAt: NOW + HOUR },
  sevenDay: weekly === null ? null : { usedPercentage: weekly, resetsAt: NOW + 24 * HOUR },
  updatedAt: NOW
})

describe('pickTrayAccount', () => {
  const accounts = [account('a'), account('b'), account('c')]
  const readings = [usage('a', 10, 20), usage('b', 90, 5), usage('c', null, 40)]

  it('auto picks the account closest to a limit', () => {
    expect(pickTrayAccount(accounts, readings, 'auto', null, NOW)).toBe('b')
  })

  it('ignores windows that already reset', () => {
    const rolled: AccountUsage = {
      ...usage('b', 90, 5),
      fiveHour: { usedPercentage: 90, resetsAt: NOW - 1 }
    }
    expect(pickTrayAccount(accounts, [readings[0], rolled, readings[2]], 'auto', null, NOW)).toBe(
      'c'
    )
  })

  it('follows the selected account and falls back to auto without one', () => {
    expect(pickTrayAccount(accounts, readings, 'selected', 'a', NOW)).toBe('a')
    expect(pickTrayAccount(accounts, readings, 'selected', null, NOW)).toBe('b')
    expect(pickTrayAccount(accounts, readings, 'selected', 'gone', NOW)).toBe('b')
  })

  it('uses a fixed account while it exists', () => {
    expect(pickTrayAccount(accounts, readings, 'c', 'a', NOW)).toBe('c')
    expect(pickTrayAccount(accounts, readings, 'deleted', null, NOW)).toBe('b')
  })

  it('falls back to the first account without usage, and null without accounts', () => {
    expect(pickTrayAccount(accounts, [], 'auto', null, NOW)).toBe('a')
    expect(pickTrayAccount([], [], 'auto', null, NOW)).toBeNull()
  })
})

describe('trayTitle', () => {
  const reading = usage('a', 5, 62)

  it('formats the chosen windows in the display mode', () => {
    expect(trayTitle(reading, 'both', 'used', 'en', NOW)).toBe('5% · 62%')
    expect(trayTitle(reading, 'session', 'used', 'en', NOW)).toBe('5%')
    expect(trayTitle(reading, 'weekly', 'used', 'en', NOW)).toBe('62%')
    expect(trayTitle(reading, 'both', 'remaining', 'en', NOW)).toBe('95% · 38%')
    expect(trayTitle(reading, 'session', 'used', 'tr', NOW)).toBe('%5')
  })

  it('leaves out missing windows and is empty without data', () => {
    expect(trayTitle(usage('a', null, 62), 'both', 'used', 'en', NOW)).toBe('62%')
    expect(trayTitle(usage('a', null, null), 'both', 'used', 'en', NOW)).toBe('')
    expect(trayTitle(undefined, 'both', 'used', 'en', NOW)).toBe('')
  })

  it('treats a window that rolled over as unused', () => {
    const rolled: AccountUsage = { ...reading, fiveHour: { usedPercentage: 80, resetsAt: NOW - 1 } }
    expect(trayTitle(rolled, 'session', 'used', 'en', NOW)).toBe('0%')
    expect(trayTitle(rolled, 'session', 'remaining', 'en', NOW)).toBe('100%')
  })

  it('never uses en or em dashes', () => {
    expect(trayTitle(reading, 'both', 'used', 'en', NOW)).not.toMatch(/[\u2013\u2014]/)
  })
})
