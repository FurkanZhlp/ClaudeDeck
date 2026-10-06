import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { Account, AccountStats } from '../../shared/types'
import type { StatsScanner } from './scanner'
import { createStatsService } from './statsService'

const account = (id: string): Account => ({ id, name: id, color: '#000', configDir: `/c/${id}` })

const stats = (accountId: string, cost: number, updatedAt: number): AccountStats => ({
  accountId,
  days: [
    {
      date: '2026-10-07',
      costUSD: cost,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    }
  ],
  updatedAt
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(accounts: Account[]) {
  let t = 1_000_000
  let cost = 1
  let active = 0
  let maxActive = 0
  const scan = vi.fn(async (_dir: string, id: string, now: number) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return stats(id, cost, now)
  })
  const scanner: StatsScanner = { scan }
  const send = vi.fn()
  const repo = { get: () => ({ accounts }) }
  const service = createStatsService({ repo, send, scanner, now: () => t })
  return {
    service,
    scan,
    send,
    advance: (ms: number) => (t += ms),
    setCost: (c: number) => (cost = c),
    maxActive: () => maxActive
  }
}

describe('createStatsService', () => {
  it('scans every account once, one at a time, and caches for 60 s', async () => {
    const s = setup([account('a'), account('b')])
    const first = await s.service.list()
    expect(first.map((x) => x.accountId)).toEqual(['a', 'b'])
    expect(s.scan).toHaveBeenCalledTimes(2)
    expect(s.maxActive()).toBe(1)

    s.advance(30_000)
    await s.service.list()
    expect(s.scan).toHaveBeenCalledTimes(2)

    s.advance(31_000)
    await s.service.list()
    expect(s.scan).toHaveBeenCalledTimes(4)
  })

  it('shares an in-flight scan between concurrent callers', async () => {
    const s = setup([account('a')])
    await Promise.all([s.service.list(), s.service.list(), s.service.refresh('a')])
    expect(s.scan).toHaveBeenCalledTimes(1)
  })

  it('sends an update only when totals change', async () => {
    const s = setup([account('a')])
    await s.service.list()
    expect(s.send).toHaveBeenCalledTimes(1)
    expect(s.send).toHaveBeenLastCalledWith(
      IPC.usageStatsUpdate,
      expect.objectContaining({ accountId: 'a' })
    )

    await s.service.refresh('a')
    expect(s.send).toHaveBeenCalledTimes(1)

    s.setCost(2)
    await s.service.refresh('a')
    expect(s.send).toHaveBeenCalledTimes(2)
  })

  it('returns null for unknown accounts and stops after dispose', async () => {
    const s = setup([account('a')])
    expect(await s.service.refresh('missing')).toBeNull()
    s.service.dispose()
    expect(await s.service.refresh('a')).toBeNull()
    expect(s.scan).not.toHaveBeenCalled()
  })
})
