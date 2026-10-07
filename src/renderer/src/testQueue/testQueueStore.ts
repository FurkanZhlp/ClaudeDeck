import { create } from 'zustand'
import type {
  ProjectTestQueue,
  TestQueueBuiltin,
  TestQueueHookStatus,
  TestQueueSettingsPatch,
  TestQueueSnapshot
} from '@shared/types'
import { errorCode, useApp } from '../store'
import { groupRuns } from './queueModel'

/** Wait and run times tick at this rate while runs exist. */
const TICK_MS = 1000

export type RunAction = 'cancel' | 'runNow' | 'release' | 'stop'

interface TestQueueStore {
  snapshot: TestQueueSnapshot | null
  hookStatus: TestQueueHookStatus | null
  /** Built-in patterns and exclusions for Settings; loaded on first use. */
  builtins: TestQueueBuiltin[] | null
  /** Shared clock for wait and run times. */
  now: number

  hydrate: () => Promise<void>
  /** Listens for snapshots from the main process; returns the cleanup. */
  subscribe: () => () => void
  loadHookStatus: () => Promise<void>
  loadBuiltins: () => Promise<void>
  act: (action: RunAction, runId: string) => Promise<void>
  /** Moves a waiting run to `position` among waiting runs (0 = next). */
  move: (runId: string, position: number) => Promise<void>
  /** Saves global settings; resolves to an error code, or null on success. */
  saveSettings: (patch: TestQueueSettingsPatch) => Promise<string | null>
  /** Saves a project's overrides; resolves to an error code, or null on success. */
  saveProject: (projectId: string, patch: Partial<ProjectTestQueue>) => Promise<string | null>
}

const cleanups: Array<() => void> = []

// A hot-reloaded module would otherwise keep the old IPC listener and timer next to the new ones.
import.meta.hot?.dispose(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

export const useTestQueue = create<TestQueueStore>()((set, get) => {
  /** Snapshots can arrive out of order (list reply after a push); the newest one wins. */
  const apply = (snapshot: TestQueueSnapshot): void => {
    const current = get().snapshot
    if (current && current.updatedAt > snapshot.updatedAt) return
    const enabledChanged = current?.enabled !== snapshot.enabled
    set({ snapshot, now: Date.now() })
    // Hooks are installed or removed with the feature switch; their status follows.
    if (enabledChanged) void get().loadHookStatus()
  }

  /** Runs an IPC call that answers with a fresh snapshot; failures go to the error toast. */
  const run = async (call: () => Promise<TestQueueSnapshot>): Promise<void> => {
    try {
      apply(await call())
    } catch (error) {
      useApp.getState().setError(errorCode(error))
    }
  }

  return {
    snapshot: null,
    hookStatus: null,
    builtins: null,
    now: Date.now(),

    async hydrate() {
      try {
        apply(await window.api.testQueue.list())
      } catch {
        // The queue is optional; without a snapshot the indicator stays hidden.
      }
    },

    subscribe() {
      const off = window.api.testQueue.onUpdate(apply)
      const timer = setInterval(() => {
        const { running, waiting } = groupRuns(get().snapshot)
        if (running.length + waiting.length > 0) set({ now: Date.now() })
      }, TICK_MS)
      const cleanup = (): void => {
        off()
        clearInterval(timer)
      }
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index !== -1) cleanups.splice(index, 1)
        cleanup()
      }
    },

    async loadHookStatus() {
      try {
        set({ hookStatus: await window.api.testQueue.hookStatus() })
      } catch {
        // Status is informational; Settings shows its loading state.
      }
    },

    async loadBuiltins() {
      if (get().builtins) return
      try {
        set({ builtins: await window.api.testQueue.builtins() })
      } catch {
        set({ builtins: [] })
      }
    },

    act(action, runId) {
      return run(() => window.api.testQueue[action](runId))
    },

    move(runId, position) {
      return run(() => window.api.testQueue.move(runId, position))
    },

    async saveSettings(patch) {
      try {
        const data = await window.api.settings.setTestQueue(patch)
        useApp.setState({ data })
        return null
      } catch (error) {
        return errorCode(error)
      }
    },

    async saveProject(projectId, patch) {
      try {
        const data = await window.api.projects.setTestQueue(projectId, patch)
        useApp.setState({ data })
        return null
      } catch (error) {
        return errorCode(error)
      }
    }
  }
})
