import { create } from 'zustand'
import type { AgentEvent, AgentSummary } from '@shared/types'
import { capEvents, mergeEvents } from './transcript'

/** Transcript of the agent shown in the detail view. */
export interface OpenAgent {
  agentId: string
  events: AgentEvent[]
  /** Pages older events in; null at the start of the transcript. */
  cursor: number | null
  /** The first page is still loading. */
  loading: boolean
  loadingOlder: boolean
  /** Opening failed (for example the agent is gone); the view offers to go back. */
  failed: boolean
}

interface AgentsStore {
  /** Claude tab whose agents are watched (the visible one), or null. */
  sessionId: string | null
  /** Summaries of that tab; null until the first list arrives. */
  agents: AgentSummary[] | null
  /** The list could not be loaded (the panel shows it instead of an empty list). */
  listFailed: boolean
  open: OpenAgent | null
  /** Starts watching a tab (replacing the previous one); summaries then arrive by push. */
  watch: (sessionId: string) => Promise<void>
  /** Stops watching the tab and closes its detail view. */
  unwatch: (sessionId: string) => void
  openAgent: (agentId: string) => Promise<void>
  closeAgent: () => void
  loadOlder: () => Promise<void>
  /** Push handlers (agents.onUpdate / agents.onEvents). */
  applyUpdate: (sessionId: string, agents: AgentSummary[]) => void
  applyEvents: (sessionId: string, agentId: string, events: AgentEvent[]) => void
}

export const useAgents = create<AgentsStore>((set, get) => {
  /** The open agent's state if it is still the one with this id. */
  const openFor = (agentId: string): OpenAgent | null => {
    const open = get().open
    return open && open.agentId === agentId ? open : null
  }

  return {
    sessionId: null,
    agents: null,
    listFailed: false,
    open: null,

    async watch(sessionId) {
      // Each watch is paired with its own unwatch by the caller (main counts references).
      get().closeAgent()
      set({ sessionId, agents: null, listFailed: false })
      try {
        const agents = await window.api.agents.watch(sessionId)
        // A push that arrived before the reply is at least as new; keep it.
        if (get().sessionId === sessionId && get().agents === null) set({ agents })
      } catch {
        if (get().sessionId === sessionId && get().agents === null) {
          set({ agents: [], listFailed: true })
        }
      }
    },

    unwatch(sessionId) {
      if (get().sessionId === sessionId) {
        get().closeAgent()
        set({ sessionId: null, agents: null, listFailed: false })
      }
      window.api.agents.unwatch(sessionId).catch(() => undefined)
    },

    async openAgent(agentId) {
      const sessionId = get().sessionId
      if (!sessionId) return
      const previous = get().open
      if (previous?.agentId === agentId) return
      if (previous) window.api.agents.close(sessionId, previous.agentId).catch(() => undefined)
      set({
        open: {
          agentId,
          events: [],
          cursor: null,
          loading: true,
          loadingOlder: false,
          failed: false
        }
      })
      try {
        const result = await window.api.agents.open(sessionId, agentId)
        const open = openFor(agentId)
        if (!open || get().sessionId !== sessionId) return
        // Live events that arrived while the page loaded are merged, not replaced.
        const capped = capEvents(mergeEvents(result.events, open.events), result.cursor)
        set({ open: { ...open, ...capped, loading: false } })
      } catch {
        const open = openFor(agentId)
        if (open) set({ open: { ...open, loading: false, failed: true } })
      }
    },

    closeAgent() {
      const { sessionId, open } = get()
      if (!open) return
      set({ open: null })
      if (sessionId) window.api.agents.close(sessionId, open.agentId).catch(() => undefined)
    },

    async loadOlder() {
      const { sessionId, open } = get()
      if (!sessionId || !open || open.loading || open.loadingOlder || open.cursor === null) return
      const { agentId, cursor } = open
      set({ open: { ...open, loadingOlder: true } })
      try {
        const page = await window.api.agents.older(sessionId, agentId, cursor)
        const current = openFor(agentId)
        if (!current || get().sessionId !== sessionId) return
        set({
          open: {
            ...current,
            events: mergeEvents(page.events, current.events),
            cursor: page.cursor,
            loadingOlder: false
          }
        })
      } catch {
        // The cursor is kept, so the button simply offers the same page again.
        const current = openFor(agentId)
        if (current) set({ open: { ...current, loadingOlder: false } })
      }
    },

    applyUpdate(sessionId, agents) {
      if (get().sessionId === sessionId) set({ agents, listFailed: false })
    },

    applyEvents(sessionId, agentId, events) {
      if (get().sessionId !== sessionId) return
      const open = openFor(agentId)
      if (!open) return
      const merged = mergeEvents(open.events, events)
      if (merged === open.events) return
      // While the first page loads there is no cursor yet; trimming waits for it.
      const capped = open.loading
        ? { events: merged, cursor: open.cursor }
        : capEvents(merged, open.cursor)
      set({ open: { ...open, ...capped } })
    }
  }
})

/** Running agents of the watched tab (the toggle's badge). */
export const runningCount = (agents: AgentSummary[] | null): number =>
  agents?.reduce((n, a) => n + (a.status === 'running' ? 1 : 0), 0) ?? 0
