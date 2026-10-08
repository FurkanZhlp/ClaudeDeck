import { create } from 'zustand'
import type { GuardLogEntry, GuardRuleInfo, GuardSettingsPatch, ProjectGuard } from '@shared/types'
import i18n from '../i18n'
import { errorCode, useApp } from '../store'
import { excerpt, nextDenyBurst, prependLogEntry, type DenyBurst } from './guardModel'

/** Longest command text shown in a deny notice. */
const NOTICE_EXCERPT = 80

interface GuardStore {
  /** Built-in rules for Settings; loaded on first use. */
  rules: GuardRuleInfo[] | null
  /** Activity log, newest first; null until Settings asks for it. */
  log: GuardLogEntry[] | null
  /** Current run of merged deny notices. */
  burst: DenyBurst | null

  loadRules: () => Promise<void>
  loadLog: () => Promise<void>
  /** Listens for guard decisions from the main process; returns the cleanup. */
  subscribe: () => () => void
  /** Saves global settings; resolves to an error code, or null on success. */
  saveSettings: (patch: GuardSettingsPatch) => Promise<string | null>
  /** Saves a project's overrides (null removes them); resolves to an error code or null. */
  saveProject: (projectId: string, patch: Partial<ProjectGuard> | null) => Promise<string | null>
}

const cleanups: Array<() => void> = []

// A hot-reloaded module would otherwise keep the old IPC listener next to the new one.
import.meta.hot?.dispose(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

/** Category name for a log entry or decision, from the backend's locale keys. */
export const guardCategoryLabel = (category: string): string =>
  i18n.t(`guard.categories.${category}`)

export const useGuard = create<GuardStore>()((set, get) => {
  /** Shows a deny as a notice; denials while one is shown merge into it. */
  const notifyDeny = (entry: GuardLogEntry): void => {
    const app = useApp.getState()
    const showing = app.notice?.source === 'guard'
    const burst = nextDenyBurst(showing ? get().burst : null, Date.now())
    set({ burst })
    const params = {
      category: guardCategoryLabel(entry.category),
      command: excerpt(entry.excerpt, NOTICE_EXCERPT),
      count: burst.count
    }
    app.setNotice({
      source: 'guard',
      message:
        burst.count > 1
          ? i18n.t('guard.notice.blockedMany', params)
          : i18n.t('guard.notice.blocked', params),
      action: {
        label: i18n.t('guard.notice.open'),
        run: () => useApp.getState().openSettings('guard')
      }
    })
  }

  return {
    rules: null,
    log: null,
    burst: null,

    async loadRules() {
      if (get().rules) return
      try {
        set({ rules: await window.api.guard.rules() })
      } catch {
        set({ rules: [] })
      }
    },

    async loadLog() {
      try {
        const loaded = await window.api.guard.log()
        // Entries pushed while the request was on its way stay on top.
        const live = get().log ?? []
        set({ log: live.reduceRight(prependLogEntry, loaded) })
      } catch {
        set({ log: get().log ?? [] })
      }
    },

    subscribe() {
      const off = window.api.guard.onEvent((entry) => {
        const log = get().log
        if (log) set({ log: prependLogEntry(log, entry) })
        if (entry.action === 'deny') notifyDeny(entry)
      })
      cleanups.push(off)
      return () => {
        const index = cleanups.indexOf(off)
        if (index !== -1) cleanups.splice(index, 1)
        off()
      }
    },

    async saveSettings(patch) {
      try {
        const data = await window.api.settings.setGuard(patch)
        useApp.setState({ data })
        return null
      } catch (error) {
        return errorCode(error)
      }
    },

    async saveProject(projectId, patch) {
      try {
        const data = await window.api.projects.setGuard(projectId, patch)
        useApp.setState({ data })
        return null
      } catch (error) {
        return errorCode(error)
      }
    }
  }
})
