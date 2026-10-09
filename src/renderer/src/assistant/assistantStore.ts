import { create } from 'zustand'
import type { AssistantApplyResult, AssistantSection } from '@shared/assistant'
import { errorCode } from '../store'
import { reduceEvent, writeLastAccount, type AssistantEvent, type RunView } from './assistantModel'

/** Rows the settings view flashes after an apply; `nonce` restarts the flash. */
export interface Highlight {
  keys: string[]
  nonce: number
}

interface AssistantStore extends RunView {
  open: boolean
  /** Section the window was opened for (pre-scoped); undefined: none. */
  section: AssistantSection | undefined
  /** Placeholder hint of a contextual entry point (i18n key). */
  hintKey: string | null
  /** The request as typed; kept for "try again". */
  prompt: string
  /** An action (start, follow-up, apply) is in flight. */
  busy: boolean
  highlight: Highlight | null

  openWindow: (opts?: { section?: AssistantSection; hintKey?: string }) => void
  /** Closes the window; a run that is still open is cancelled. */
  closeWindow: () => void
  setPrompt: (prompt: string) => void
  start: (prompt: string, accountId: string, projectId?: string) => Promise<void>
  followUp: (text: string) => Promise<boolean>
  /** Applies the shown proposal; resolves to the result, or null after an error. */
  apply: (confirmed: string[]) => Promise<AssistantApplyResult | null>
  /** Declines the shown proposal and closes the window. */
  reject: () => Promise<void>
  /** Back to the request, keeping the text (after an error). */
  retry: () => void
  undo: (token: string) => Promise<boolean>
  flash: (keys: string[]) => void
  /** Listens for run events from the main process; returns the cleanup. */
  subscribe: () => () => void
}

const idle = (): RunView => ({ runId: null, view: { step: 'compose' } })

const failure = (error: unknown): RunView['view'] => ({
  step: 'error',
  code: errorCode(error),
  detail: null
})

export const useAssistant = create<AssistantStore>()((set, get) => {
  const receive = (event: AssistantEvent): void => {
    const { runId, view } = get()
    const next = reduceEvent({ runId, view }, event)
    if (next.runId !== runId || next.view !== view) set(next)
  }

  /**
   * Cancels the open run in the background (refused harmlessly when it already ended); its late
   * events are ignored after this.
   */
  const dropRun = (): void => {
    const { runId } = get()
    if (runId) void window.api.assistant.cancel(runId).catch(() => undefined)
  }

  return {
    ...idle(),
    open: false,
    section: undefined,
    hintKey: null,
    prompt: '',
    busy: false,
    highlight: null,

    openWindow(opts = {}) {
      dropRun()
      set({
        ...idle(),
        open: true,
        section: opts.section,
        hintKey: opts.hintKey ?? null,
        prompt: '',
        busy: false
      })
    },

    closeWindow() {
      dropRun()
      set({ ...idle(), open: false, busy: false })
    },

    setPrompt: (prompt) => set({ prompt }),

    async start(prompt, accountId, projectId) {
      if (get().busy) return
      writeLastAccount(accountId)
      set({ prompt, busy: true, runId: null, view: { step: 'working', phase: 'starting' } })
      try {
        const { runId } = await window.api.assistant.start({
          prompt,
          accountId,
          ...(get().section ? { section: get().section } : {}),
          ...(projectId ? { projectId } : {})
        })
        // Closed while starting: stop the run that was just created.
        if (!get().open) {
          void window.api.assistant.cancel(runId).catch(() => undefined)
          return
        }
        if (get().runId === null) set({ runId })
      } catch (error) {
        if (get().open) set({ view: failure(error) })
      } finally {
        set({ busy: false })
      }
    },

    async followUp(text) {
      const { runId, busy } = get()
      if (!runId || busy) return false
      set({ busy: true })
      try {
        await window.api.assistant.followUp(runId, text)
        set({ view: { step: 'working', phase: 'thinking' } })
        return true
      } catch (error) {
        set({ view: failure(error) })
        return false
      } finally {
        set({ busy: false })
      }
    },

    async apply(confirmed) {
      const { view, busy } = get()
      if (view.step !== 'proposal' || busy) return null
      set({ busy: true })
      try {
        const result = await window.api.assistant.apply(view.proposal.id, confirmed)
        // The run is over; closing must not cancel anything.
        set({ ...idle(), open: false })
        return result
      } catch (error) {
        set({ view: failure(error) })
        return null
      } finally {
        set({ busy: false })
      }
    },

    async reject() {
      const { view } = get()
      if (view.step === 'proposal') {
        await window.api.assistant.reject(view.proposal.id).catch(() => undefined)
        set({ runId: null })
      }
      get().closeWindow()
    },

    retry() {
      dropRun()
      set({ ...idle(), busy: false })
    },

    async undo(token) {
      try {
        await window.api.assistant.undo(token)
        return true
      } catch {
        return false
      }
    },

    flash: (keys) => set({ highlight: { keys, nonce: Date.now() } }),

    subscribe() {
      const api = window.api.assistant
      const offs = [
        api.onStatus((e) => receive({ type: 'status', runId: e.runId, phase: e.phase })),
        api.onProposal((p) => receive({ type: 'proposal', runId: p.runId, proposal: p })),
        api.onQuestion((q) => receive({ type: 'question', runId: q.runId, question: q })),
        api.onDone((e) => receive({ type: 'done', runId: e.runId, event: e })),
        api.onError((e) => receive({ type: 'error', runId: e.runId, event: e }))
      ]
      return () => offs.forEach((off) => off())
    }
  }
})
