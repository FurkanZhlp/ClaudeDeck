import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { OptimizeDecision, OptimizeState, OptimizeStatus } from '@shared/types'
import { errorCode, useApp } from '../store'

/** Statuses in which Claude is still working on the profile in the background. */
export const LIVE_STATUSES: readonly OptimizeStatus[] = ['starting', 'running', 'waiting']

export const isLive = (status: OptimizeStatus | undefined): boolean =>
  status !== undefined && LIVE_STATUSES.includes(status)

interface OptimizeStore {
  runs: Record<string, OptimizeState>
  /** Last failed call per account, shown inline (the global toast can sit behind a screen). */
  errors: Record<string, string | null>

  hydrate: () => Promise<void>
  /** Listens for run updates from the main process; returns the unsubscribe function. */
  subscribe: () => () => void
  start: (accountId: string) => Promise<boolean>
  answer: (
    accountId: string,
    questionId: string,
    decision: OptimizeDecision,
    note?: string
  ) => Promise<boolean>
  cancel: (accountId: string) => Promise<boolean>
  revert: (accountId: string) => Promise<boolean>
}

const subscriptions: Array<() => void> = []

// A hot-reloaded module would otherwise keep the old IPC listener next to the new one.
import.meta.hot?.dispose(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
})

/**
 * A reply to an earlier call can arrive after a newer pushed update of the same run;
 * such a stale snapshot (same run, fewer events) is ignored.
 */
function isStale(current: OptimizeState | undefined, incoming: OptimizeState): boolean {
  return (
    current !== undefined &&
    current.startedAt === incoming.startedAt &&
    current.events.length > incoming.events.length
  )
}

export const useOptimize = create<OptimizeStore>((set, get) => {
  function apply(state: OptimizeState): void {
    const { runs, errors } = get()
    if (isStale(runs[state.accountId], state)) return
    set({
      runs: { ...runs, [state.accountId]: state },
      errors: { ...errors, [state.accountId]: null }
    })
  }

  async function call(accountId: string, fn: () => Promise<OptimizeState>): Promise<boolean> {
    try {
      apply(await fn())
      return true
    } catch (error) {
      const code = errorCode(error)
      set({ errors: { ...get().errors, [accountId]: code } })
      useApp.getState().setError(code)
      return false
    }
  }

  return {
    runs: {},
    errors: {},

    async hydrate() {
      try {
        const list = await window.api.optimize.list()
        const runs = { ...get().runs }
        for (const state of list) {
          if (!isStale(runs[state.accountId], state)) runs[state.accountId] = state
        }
        set({ runs })
      } catch (error) {
        useApp.getState().setError(errorCode(error))
      }
    },

    subscribe() {
      const unsubscribe = window.api.optimize.onUpdate(apply)
      subscriptions.push(unsubscribe)
      return () => {
        const index = subscriptions.indexOf(unsubscribe)
        if (index !== -1) subscriptions.splice(index, 1)
        unsubscribe()
      }
    },

    start: (accountId) => call(accountId, () => window.api.optimize.start(accountId)),
    answer: (accountId, questionId, decision, note) =>
      call(accountId, () => window.api.optimize.answer(accountId, questionId, decision, note)),
    cancel: (accountId) => call(accountId, () => window.api.optimize.cancel(accountId)),
    revert: (accountId) => call(accountId, () => window.api.optimize.revert(accountId))
  }
})

/** The account's optimization run, if one was ever started in this app session. */
export const useOptimizeRun = (accountId: string): OptimizeState | undefined =>
  useOptimize((s) => s.runs[accountId])

/** Accounts whose run is paused on a proposal waiting for the user's answer. */
export const useOptimizeAttention = (): string[] =>
  useOptimize(
    useShallow((s) =>
      Object.values(s.runs)
        .filter((run) => run.status === 'waiting' && run.pending !== null)
        .map((run) => run.accountId)
    )
  )

export type OptimizeBadgeState = 'running' | 'waiting' | null

/** What the account's rail badge shows: Claude working, waiting for an answer, or nothing. */
export const useOptimizeBadgeState = (accountId: string): OptimizeBadgeState =>
  useOptimize((s) => {
    const run = s.runs[accountId]
    if (!run || !isLive(run.status)) return null
    return run.status === 'waiting' || run.pending !== null ? 'waiting' : 'running'
  })
