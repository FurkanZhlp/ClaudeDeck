import { create } from 'zustand'
import type { AccountUsage } from '@shared/types'

/** How often `now` advances, so countdowns, forecasts and resets stay current. */
const TICK_MS = 30_000

interface UsageStore {
  /** Latest report per account id. */
  byAccount: Record<string, AccountUsage>
  /** Shared clock for everything derived from usage; ticks while someone is subscribed. */
  now: number

  hydrate: () => Promise<void>
  /** Listens for reports from the main process and starts the clock; returns the cleanup. */
  subscribe: () => () => void
}

const cleanups: Array<() => void> = []

// A hot-reloaded module would otherwise keep the old IPC listener and timer next to the new ones.
import.meta.hot?.dispose(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

export const useUsage = create<UsageStore>()((set, get) => {
  /** Reports can arrive out of order (list reply after a push); the newest one wins. */
  const apply = (usage: AccountUsage): void => {
    const current = get().byAccount[usage.accountId]
    if (current && current.updatedAt > usage.updatedAt) return
    set({ byAccount: { ...get().byAccount, [usage.accountId]: usage }, now: Date.now() })
  }

  return {
    byAccount: {},
    now: Date.now(),

    async hydrate() {
      try {
        const list = await window.api.usage.list()
        list.forEach(apply)
      } catch {
        // Usage is a nice-to-have; the panel simply shows its empty state.
      }
    },

    subscribe() {
      const unsubscribe = window.api.usage.onUpdate(apply)
      const timer = setInterval(() => set({ now: Date.now() }), TICK_MS)
      const cleanup = (): void => {
        unsubscribe()
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
