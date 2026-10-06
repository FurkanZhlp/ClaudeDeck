import { IPC } from '../../shared/ipc'
import type { Account, AccountStats } from '../../shared/types'
import { createStatsScanner, DEFAULT_STATS_DAYS, type StatsScanner } from './scanner'

/** Stats younger than this are served from memory. */
export const STATS_MAX_AGE_MS = 60_000

interface Deps {
  repo: { get(): { accounts: Account[] } }
  send: (channel: string, ...args: unknown[]) => void
  scanner?: StatsScanner
  now?: () => number
  maxAgeMs?: number
  days?: number
}

export interface StatsService {
  /** Stats of every account, rescanning those older than the max age. */
  list(): Promise<AccountStats[]>
  /** Rescans one account now; null when the account is unknown. */
  refresh(accountId: string): Promise<AccountStats | null>
  dispose(): void
}

const sameTotals = (a: AccountStats | undefined, b: AccountStats): boolean =>
  a !== undefined && JSON.stringify(a.days) === JSON.stringify(b.days)

export function createStatsService({
  repo,
  send,
  scanner = createStatsScanner(),
  now = Date.now,
  maxAgeMs = STATS_MAX_AGE_MS,
  days = DEFAULT_STATS_DAYS
}: Deps): StatsService {
  const results = new Map<string, AccountStats>()
  const inflight = new Map<string, Promise<AccountStats>>()
  // Scans run one at a time so large histories never pile up on the main process.
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false

  const run = (account: Account): Promise<AccountStats> => {
    const pending = inflight.get(account.id)
    if (pending) return pending
    const job = queue.then(async () => {
      const previous = results.get(account.id)
      try {
        const stats = await scanner.scan(account.configDir, account.id, now(), days)
        if (disposed) return stats
        if (repo.get().accounts.some((a) => a.id === account.id)) {
          results.set(account.id, stats)
          if (!sameTotals(previous, stats)) send(IPC.usageStatsUpdate, stats)
        }
        return stats
      } catch (error) {
        console.warn('[stats] scan failed', account.id, error)
        return previous ?? { accountId: account.id, days: [], updatedAt: now() }
      } finally {
        inflight.delete(account.id)
      }
    })
    inflight.set(account.id, job)
    queue = job
    return job
  }

  return {
    async list() {
      const accounts = repo.get().accounts
      const ids = new Set(accounts.map((a) => a.id))
      for (const id of results.keys()) if (!ids.has(id)) results.delete(id)
      if (disposed) return accounts.flatMap((a) => results.get(a.id) ?? [])
      const t = now()
      return Promise.all(
        accounts.map((account) => {
          const cached = results.get(account.id)
          return cached && t - cached.updatedAt < maxAgeMs ? cached : run(account)
        })
      )
    },
    async refresh(accountId) {
      const account = repo.get().accounts.find((a) => a.id === accountId)
      if (!account || disposed) return null
      return run(account)
    },
    dispose() {
      disposed = true
      results.clear()
    }
  }
}
