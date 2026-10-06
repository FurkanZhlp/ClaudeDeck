import { create } from 'zustand'
import type { AccountPlan, AccountStats, AccountUsage } from '@shared/types'

/** How often `now` advances, so countdowns, forecasts and resets stay current. */
const TICK_MS = 30_000

export type DetailsStatus = 'idle' | 'loading' | 'ready'

interface UsageStore {
  /** Latest report per account id. */
  byAccount: Record<string, AccountUsage>
  /** Subscription details per account id (only loaded for the details view). */
  plans: Record<string, AccountPlan>
  /** Local transcript statistics per account id (only loaded for the details view). */
  stats: Record<string, AccountStats>
  /** Whether plans and stats were fetched at least once. */
  detailsStatus: DetailsStatus
  /** Shared clock for everything derived from usage; ticks while someone is subscribed. */
  now: number

  hydrate: () => Promise<void>
  /** Loads plans and statistics; called when the details view opens. */
  hydrateDetails: () => Promise<void>
  /** Asks the main process for fresh plan usage and statistics. */
  refresh: (accountId?: string) => Promise<void>
  /** Listens for reports from the main process and starts the clock; returns the cleanup. */
  subscribe: () => () => void
}

const cleanups: Array<() => void> = []

// A hot-reloaded module would otherwise keep the old IPC listener and timer next to the new ones.
import.meta.hot?.dispose(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

/** Turns a list into a record by account id. */
const byId = <T extends { accountId: string }>(list: T[]): Record<string, T> =>
  Object.fromEntries(list.map((item) => [item.accountId, item]))

export const useUsage = create<UsageStore>()((set, get) => {
  /** Reports can arrive out of order (list reply after a push); the newest one wins. */
  const apply = (usage: AccountUsage): void => {
    const current = get().byAccount[usage.accountId]
    if (current && current.updatedAt > usage.updatedAt) return
    set({ byAccount: { ...get().byAccount, [usage.accountId]: usage }, now: Date.now() })
  }

  const applyStats = (stats: AccountStats): void => {
    const current = get().stats[stats.accountId]
    if (current && current.updatedAt > stats.updatedAt) return
    set({ stats: { ...get().stats, [stats.accountId]: stats } })
  }

  // Each source fails on its own: an older main process may not answer every channel yet.
  const loadPlans = async (): Promise<void> => {
    try {
      set({ plans: byId(await window.api.usage.plans()) })
    } catch {
      // The plan label is optional; the view falls back to the account name alone.
    }
  }
  const loadStats = async (): Promise<void> => {
    try {
      ;(await window.api.usage.stats()).forEach(applyStats)
    } catch {
      // Without statistics the cost section shows its empty state.
    }
  }

  return {
    byAccount: {},
    plans: {},
    stats: {},
    detailsStatus: 'idle',
    now: Date.now(),

    async hydrate() {
      try {
        const list = await window.api.usage.list()
        list.forEach(apply)
      } catch {
        // Usage is a nice-to-have; the panel simply shows its empty state.
      }
    },

    async hydrateDetails() {
      if (get().detailsStatus === 'idle') set({ detailsStatus: 'loading' })
      await Promise.all([loadPlans(), loadStats()])
      set({ detailsStatus: 'ready', now: Date.now() })
    },

    async refresh(accountId) {
      const poll = async (): Promise<void> => {
        try {
          await window.api.usage.pollNow(accountId)
        } catch {
          // Throttled or unavailable; fresh numbers still arrive through onUpdate later.
        }
      }
      await Promise.all([poll(), loadStats(), loadPlans()])
      set({ now: Date.now() })
    },

    subscribe() {
      const offUsage = window.api.usage.onUpdate(apply)
      const offStats = window.api.usage.onStats(applyStats)
      const timer = setInterval(() => set({ now: Date.now() }), TICK_MS)
      const cleanup = (): void => {
        offUsage()
        offStats()
        clearInterval(timer)
      }
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index !== -1) cleanups.splice(index, 1)
        cleanup()
      }
    }
  }
})

export const useAccountUsage = (accountId: string | null): AccountUsage | undefined =>
  useUsage((s) => (accountId ? s.byAccount[accountId] : undefined))
