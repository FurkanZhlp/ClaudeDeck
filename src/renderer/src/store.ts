import { create } from 'zustand'
import { resolveLanguage } from '@shared/language'
import type {
  AccountInput,
  AccountStatus,
  AppState,
  Language,
  ProjectInput,
  SessionKind
} from '@shared/types'
import i18n from './i18n'
import * as pool from './terminal/terminalPool'

export type Running = { accountId: string; exitCode: number | null; runId: number }
export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string } | null
export type StatusEntry = AccountStatus | 'checking'

export const errorCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN'

interface AppStore {
  data: AppState | null
  statuses: Record<string, StatusEntry>
  claudeAvailable: boolean | null
  selectedProjectId: string | null
  selectedSessionId: string | null
  lastSession: Record<string, string>
  running: Record<string, Running>
  settingsOpen: boolean
  projectDialog: ProjectDialogState
  loginAccountId: string | null
  error: string | null

  init: () => Promise<void>
  setError: (code: string | null) => void
  setLanguage: (language: Language | null) => Promise<void>
  refreshStatus: (accountId: string) => Promise<void>
  createAccount: (input: AccountInput) => Promise<void>
  removeAccount: (id: string, deleteFiles: boolean) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setProjectDialog: (state: ProjectDialogState) => void
  setLoginAccount: (accountId: string | null) => void
  saveProject: (input: ProjectInput, editId?: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  selectProject: (id: string) => void
  selectSession: (id: string) => void
  createSession: (kind: SessionKind) => Promise<void>
  startSession: (id: string, resume: boolean) => void
  spawn: (id: string, resume: boolean, cols: number, rows: number) => Promise<void>
  closeSession: (id: string) => Promise<void>
}

let initialized = false

function applyLanguage(state: AppState): void {
  const language = resolveLanguage(state.settings.language, navigator.language)
  void i18n.changeLanguage(language)
  document.documentElement.lang = language
}

function firstSessionOf(state: AppState, projectId: string | null): string | null {
  if (!projectId) return null
  return (
    state.sessions
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null
  )
}

export const useApp = create<AppStore>((set, get) => {
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      set({ error: errorCode(error) })
      return undefined
    }
  }

  return {
    data: null,
    statuses: {},
    claudeAvailable: null,
    selectedProjectId: null,
    selectedSessionId: null,
    lastSession: {},
    running: {},
    settingsOpen: false,
    projectDialog: null,
    loginAccountId: null,
    error: null,

    async init() {
      if (initialized) return
      initialized = true
      window.api.pty.onData((id, data) => pool.write(id, data))
      window.api.pty.onExit((id, exitCode) => {
        const run = get().running[id]
        if (run) set({ running: { ...get().running, [id]: { ...run, exitCode } } })
      })
      window.api.system.onOpenSettings(() => set({ settingsOpen: true }))

      const data = await window.api.state.get()
      applyLanguage(data)
      const selectedProjectId = data.projects[0]?.id ?? null
      set({ data, selectedProjectId, selectedSessionId: firstSessionOf(data, selectedProjectId) })
      void window.api.system.claudeAvailable().then((claudeAvailable) => set({ claudeAvailable }))
      data.accounts.forEach((account) => void get().refreshStatus(account.id))
    },

    setError: (error) => set({ error }),

    async setLanguage(language) {
      const data = await guard(() => window.api.settings.setLanguage(language))
      if (!data) return
      set({ data })
      applyLanguage(data)
    },

    async refreshStatus(accountId) {
      set({ statuses: { ...get().statuses, [accountId]: 'checking' } })
      const result = await guard(() => window.api.accounts.status(accountId))
      const statuses = { ...get().statuses }
      if (result) {
        statuses[accountId] = result.status
        set({ data: result.state, statuses })
      } else {
        delete statuses[accountId]
        set({ statuses })
      }
    },

    async createAccount(input) {
      const result = await guard(() => window.api.accounts.create(input))
      if (result) set({ data: result.state, loginAccountId: result.account.id })
    },

    async removeAccount(id, deleteFiles) {
      const data = await guard(() => window.api.accounts.remove(id, deleteFiles))
      if (!data) return
      const statuses = { ...get().statuses }
      delete statuses[id]
      set({ data, statuses })
    },

    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setProjectDialog: (projectDialog) => set({ projectDialog }),
    setLoginAccount: (loginAccountId) => set({ loginAccountId }),

    async saveProject(input, editId) {
      const data = await guard(() =>
        editId ? window.api.projects.update(editId, input) : window.api.projects.create(input)
      )
      if (!data) return
      if (editId) {
        set({ data, projectDialog: null })
      } else {
        set({
          data,
          projectDialog: null,
          selectedProjectId: data.projects.at(-1)?.id ?? null,
          selectedSessionId: null
        })
      }
    },

    async removeProject(id) {
      const before = get().data
      const data = await guard(() => window.api.projects.remove(id))
      if (!data || !before) return
      const running = { ...get().running }
      for (const session of before.sessions.filter((s) => s.projectId === id)) {
        pool.dispose(session.id)
        delete running[session.id]
      }
      const selectedProjectId = data.projects[0]?.id ?? null
      set({
        data,
        running,
        projectDialog: null,
        selectedProjectId,
        selectedSessionId: firstSessionOf(data, selectedProjectId)
      })
    },

    selectProject(id) {
      const { data, lastSession } = get()
      if (!data) return
      const remembered = lastSession[id]
      const valid = remembered && data.sessions.some((s) => s.id === remembered)
      set({
        selectedProjectId: id,
        selectedSessionId: valid ? remembered : firstSessionOf(data, id)
      })
    },

    selectSession(id) {
      const session = get().data?.sessions.find((s) => s.id === id)
      if (!session) return
      set({
        selectedProjectId: session.projectId,
        selectedSessionId: id,
        lastSession: { ...get().lastSession, [session.projectId]: id }
      })
    },

    async createSession(kind) {
      const { data, selectedProjectId } = get()
      const project = data?.projects.find((p) => p.id === selectedProjectId)
      if (!data || !project) return
      const n =
        data.sessions.filter((s) => s.projectId === project.id && s.kind === kind).length + 1
      const title = i18n.t(kind === 'claude' ? 'session.claudeTitle' : 'session.shellTitle', { n })
      const result = await guard(() => window.api.sessions.create(project.id, kind, title))
      if (!result) return
      set({ data: result.state })
      get().selectSession(result.session.id)
      const status = get().statuses[project.accountId]
      const signedOut = kind === 'claude' && typeof status === 'object' && !status.loggedIn
      if (!signedOut) get().startSession(result.session.id, false)
    },

    startSession(id, resume) {
      const { data, running } = get()
      const session = data?.sessions.find((s) => s.id === id)
      const project = data?.projects.find((p) => p.id === session?.projectId)
      if (!session || !project) return
      pool.requestStart(id, resume)
      const runId = (running[id]?.runId ?? 0) + 1
      set({
        running: { ...running, [id]: { accountId: project.accountId, exitCode: null, runId } }
      })
    },

    async spawn(id, resume, cols, rows) {
      const result = await guard(() => window.api.pty.startSession(id, resume, cols, rows))
      const running = { ...get().running }
      const run = running[id]
      if (result && run) running[id] = { ...run, accountId: result.accountId }
      if (!result) delete running[id]
      set({ running })
    },

    async closeSession(id) {
      const data = await guard(() => window.api.sessions.remove(id))
      if (!data) return
      pool.dispose(id)
      const running = { ...get().running }
      delete running[id]
      const { selectedProjectId, selectedSessionId } = get()
      set({
        data,
        running,
        selectedSessionId:
          selectedSessionId === id ? firstSessionOf(data, selectedProjectId) : selectedSessionId
      })
    }
  }
})
