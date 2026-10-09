import { create } from 'zustand'
import { resolveLanguage } from '@shared/language'
import type {
  AccountInput,
  AccountStatus,
  AppState,
  ClaudeSettings,
  Language,
  PermissionMode,
  ProjectClaudePatch,
  ProjectInput,
  SessionKind,
  UpdateInfo,
  UsageSettings
} from '@shared/types'
import i18n from './i18n'
import { readLastSection, writeLastSection, type SettingsSectionId } from './settings/sectionIds'
import * as pool from './terminal/terminalPool'

export type Running = {
  accountId: string
  exitCode: number | null
  runId: number
  /** Mode the Claude tab was started in; set once the process is running. */
  permissionMode?: PermissionMode | null
}
export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string } | null
export type StatusEntry = AccountStatus | 'checking'

/** An in-app notice toast; `action` adds a button (for example, open a settings section). */
export interface AppNotice {
  message: string
  action?: { label: string; run: () => void }
  /**
   * `guard` notices merge (command guard denials); `guardEvent` notices (tamper, project config)
   * stand alone. Both show the guard icon.
   */
  source?: 'guard' | 'guardEvent'
  /** Icon color for guard notices; defaults to danger. */
  tone?: 'warn' | 'danger'
}

export const errorCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN'

interface AppStore {
  data: AppState | null
  statuses: Record<string, StatusEntry>
  claudeAvailable: boolean | null
  selectedAccountId: string | null
  lastProject: Record<string, string>
  selectedProjectId: string | null
  selectedSessionId: string | null
  lastSession: Record<string, string>
  running: Record<string, Running>
  settingsOpen: boolean
  /** Section shown in the settings view; remembered across openings. */
  settingsSection: SettingsSectionId
  projectDialog: ProjectDialogState
  loginAccountId: string | null
  error: string | null
  notice: AppNotice | null
  update: UpdateInfo | null

  init: () => Promise<void>
  setError: (code: string | null) => void
  setNotice: (notice: AppNotice | string | null) => void
  setLanguage: (language: Language | null) => Promise<void>
  setUsageSettings: (patch: Partial<UsageSettings>) => Promise<void>
  setLaunchAtLogin: (enabled: boolean) => Promise<void>
  setClaudeSettings: (patch: Partial<ClaudeSettings>) => Promise<void>
  setProjectClaude: (id: string, patch: ProjectClaudePatch) => Promise<void>
  refreshStatus: (accountId: string) => Promise<void>
  /** Creates the account and selects it; returns its id so the caller can start onboarding. */
  createAccount: (input: AccountInput) => Promise<string | null>
  updateAccount: (id: string, patch: Partial<AccountInput>) => Promise<boolean>
  removeAccount: (id: string, deleteFiles: boolean) => Promise<void>
  /** Opens the settings view at `section`, or at the last section shown. */
  openSettings: (section?: SettingsSectionId) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSectionId) => void
  setProjectDialog: (state: ProjectDialogState) => void
  setLoginAccount: (accountId: string | null) => void
  saveProject: (input: ProjectInput, editId?: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  selectAccount: (id: string) => void
  selectProject: (id: string) => void
  selectSession: (id: string) => void
  /** `permissionMode` pins a new Claude tab's mode; omitted inherits project/global. */
  createSession: (kind: SessionKind, permissionMode?: PermissionMode) => Promise<void>
  startSession: (id: string, resume: boolean) => void
  spawn: (id: string, resume: boolean, cols: number, rows: number) => Promise<void>
  closeSession: (id: string) => Promise<void>
  dismissUpdate: () => void
}

let initialized = false
const subscriptions: Array<() => void> = []

// In development a hot-reloaded store would otherwise add a second set of IPC listeners,
// writing every byte of terminal output twice.
import.meta.hot?.dispose(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
})
// Aynı hesap için çakışan durum sorgularında yalnızca en sonuncusu uygulanır.
const statusRequests: Record<string, number> = {}

export function applyLanguage(state: AppState): void {
  const language = resolveLanguage(state.settings.language, navigator.language)
  void i18n.changeLanguage(language)
  document.documentElement.lang = language
}

type Selection = Pick<AppStore, 'selectedAccountId' | 'selectedProjectId' | 'selectedSessionId'>

function lastOrFirst(remembered: string | undefined, ids: string[]): string | null {
  return remembered && ids.includes(remembered) ? remembered : (ids[0] ?? null)
}

/** Selection after switching to an account: its last used project and that project's last tab. */
function focusAccount(
  state: AppState,
  accountId: string | null,
  lastProject: Record<string, string>,
  lastSession: Record<string, string>
): Selection {
  if (!accountId)
    return { selectedAccountId: null, selectedProjectId: null, selectedSessionId: null }
  const projectIds = state.projects.filter((p) => p.accountId === accountId).map((p) => p.id)
  const projectId = lastOrFirst(lastProject[accountId], projectIds)
  const sessionIds = state.sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => s.id)
  return {
    selectedAccountId: accountId,
    selectedProjectId: projectId,
    selectedSessionId: projectId ? lastOrFirst(lastSession[projectId], sessionIds) : null
  }
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
    selectedAccountId: null,
    lastProject: {},
    selectedProjectId: null,
    selectedSessionId: null,
    lastSession: {},
    running: {},
    settingsOpen: false,
    settingsSection: readLastSection(),
    projectDialog: null,
    loginAccountId: null,
    error: null,
    notice: null,
    update: null,

    async init() {
      if (initialized) return
      initialized = true
      subscriptions.push(
        window.api.pty.onData((id, data) => pool.write(id, data)),
        window.api.pty.onExit((id, exitCode) => {
          const run = get().running[id]
          if (run) set({ running: { ...get().running, [id]: { ...run, exitCode } } })
        }),
        window.api.system.onOpenSettings(() => get().openSettings()),
        window.api.update.onAvailable((update) => set({ update })),
        // Changes made by the main process itself, e.g. through the ClaudeDeck MCP server.
        window.api.state.onChanged((data) => set({ data })),
        // Claude asked (and the user approved) to open a tab; it waits for a click to start.
        window.api.sessions.onOpenRequest((sessionId) => get().selectSession(sessionId)),
        window.api.profile.onGuidelinesUpdated((update) => {
          const account = get().data?.accounts.find((a) => a.id === update.accountId)
          set({
            notice: {
              message: i18n.t('notices.guidelinesUpdated', {
                account: account?.name ?? '',
                version: update.to
              })
            }
          })
        })
      )

      const data = await guard(() => window.api.state.get())
      if (!data) {
        initialized = false
        return
      }
      applyLanguage(data)
      const accountId = data.projects[0]?.accountId ?? data.accounts[0]?.id ?? null
      set({ data, ...focusAccount(data, accountId, {}, {}) })
      void window.api.system.claudeAvailable().then((claudeAvailable) => set({ claudeAvailable }))
      data.accounts.forEach((account) => void get().refreshStatus(account.id))
      void window.api.update.check().then((update) => update?.available && set({ update }))
      void window.api.profile.takeGuidelineUpdates().then((updates) => {
        const update = updates.at(-1)
        const account = data.accounts.find((a) => a.id === update?.accountId)
        if (update && account) {
          set({
            notice: {
              message: i18n.t('notices.guidelinesUpdated', {
                account: account.name,
                version: update.to
              })
            }
          })
        }
      })
    },

    setError: (error) => set({ error }),
    setNotice: (notice) =>
      set({ notice: typeof notice === 'string' ? { message: notice } : notice }),

    async setLanguage(language) {
      const data = await guard(() => window.api.settings.setLanguage(language))
      if (!data) return
      set({ data })
      applyLanguage(data)
    },

    async setUsageSettings(patch) {
      const data = await guard(() => window.api.settings.setUsage(patch))
      if (data) set({ data })
    },

    async setLaunchAtLogin(enabled) {
      const data = await guard(() => window.api.settings.setLaunchAtLogin(enabled))
      if (data) set({ data })
    },

    async setClaudeSettings(patch) {
      const data = await guard(() => window.api.settings.setClaude(patch))
      if (data) set({ data })
    },

    async setProjectClaude(id, patch) {
      const data = await guard(() => window.api.projects.setClaude(id, patch))
      if (data) set({ data })
    },

    async refreshStatus(accountId) {
      const request = (statusRequests[accountId] ?? 0) + 1
      statusRequests[accountId] = request
      set({ statuses: { ...get().statuses, [accountId]: 'checking' } })
      const result = await guard(() => window.api.accounts.status(accountId))
      if (statusRequests[accountId] !== request) return
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
      if (!result) return null
      set({
        data: result.state,
        ...focusAccount(result.state, result.account.id, get().lastProject, get().lastSession)
      })
      void get().refreshStatus(result.account.id)
      return result.account.id
    },

    async updateAccount(id, patch) {
      const data = await guard(() => window.api.accounts.update(id, patch))
      if (data) set({ data })
      return !!data
    },

    async removeAccount(id, deleteFiles) {
      const data = await guard(() => window.api.accounts.remove(id, deleteFiles))
      if (!data) return
      const statuses = { ...get().statuses }
      delete statuses[id]
      const { selectedAccountId, lastProject, lastSession } = get()
      const selection =
        selectedAccountId === id
          ? focusAccount(data, data.accounts[0]?.id ?? null, lastProject, lastSession)
          : {}
      set({ data, statuses, ...selection })
    },

    openSettings(section) {
      if (section) get().setSettingsSection(section)
      set({ settingsOpen: true })
    },
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection(settingsSection) {
      writeLastSection(settingsSection)
      set({ settingsSection })
    },
    setProjectDialog: (projectDialog) => set({ projectDialog }),
    setLoginAccount: (loginAccountId) => set({ loginAccountId }),

    async saveProject(input, editId) {
      const data = await guard(() =>
        editId ? window.api.projects.update(editId, input) : window.api.projects.create(input)
      )
      if (!data) return
      const projectId = editId ?? data.projects.at(-1)?.id
      const project = data.projects.find((p) => p.id === projectId)
      // A new project, or the selected one moved to another account, takes the selection along.
      if (project && (!editId || get().selectedProjectId === editId)) {
        set({
          data,
          projectDialog: null,
          selectedAccountId: project.accountId,
          selectedProjectId: project.id,
          selectedSessionId: editId ? get().selectedSessionId : null,
          lastProject: { ...get().lastProject, [project.accountId]: project.id }
        })
      } else {
        set({ data, projectDialog: null })
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
      if (get().selectedProjectId !== id) {
        set({ data, running, projectDialog: null })
        return
      }
      const { selectedAccountId, lastProject, lastSession } = get()
      set({
        data,
        running,
        projectDialog: null,
        ...focusAccount(data, selectedAccountId, lastProject, lastSession)
      })
    },

    selectAccount(id) {
      const { data, lastProject, lastSession } = get()
      if (data) set(focusAccount(data, id, lastProject, lastSession))
    },

    selectProject(id) {
      const { data, lastSession } = get()
      if (!data) return
      const remembered = lastSession[id]
      const valid = remembered && data.sessions.some((s) => s.id === remembered)
      const project = data.projects.find((p) => p.id === id)
      if (!project) return
      set({
        selectedAccountId: project.accountId,
        selectedProjectId: id,
        selectedSessionId: valid ? remembered : firstSessionOf(data, id),
        lastProject: { ...get().lastProject, [project.accountId]: id }
      })
    },

    selectSession(id) {
      const data = get().data
      const session = data?.sessions.find((s) => s.id === id)
      const project = data?.projects.find((p) => p.id === session?.projectId)
      if (!session || !project) return
      set({
        selectedAccountId: project.accountId,
        lastProject: { ...get().lastProject, [project.accountId]: project.id },
        selectedProjectId: session.projectId,
        selectedSessionId: id,
        lastSession: { ...get().lastSession, [session.projectId]: id }
      })
    },

    async createSession(kind, permissionMode) {
      const { data, selectedProjectId } = get()
      const project = data?.projects.find((p) => p.id === selectedProjectId)
      if (!data || !project) return
      const n =
        data.sessions.filter((s) => s.projectId === project.id && s.kind === kind).length + 1
      const title = i18n.t(kind === 'claude' ? 'session.claudeTitle' : 'session.shellTitle', { n })
      const result = await guard(() =>
        window.api.sessions.create(project.id, kind, title, permissionMode)
      )
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
      if (result && run) {
        running[id] = { ...run, accountId: result.accountId, permissionMode: result.permissionMode }
      }
      if (!result) delete running[id]
      set({ running })
    },

    dismissUpdate: () => set({ update: null }),

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
