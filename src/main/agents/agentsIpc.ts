import type { BrowserWindow } from 'electron'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { AgentSummary } from '../../shared/types'
import { isText, type IpcTools } from '../ipcUtil'
import type { Repository } from '../state/repository'
import { AgentSessionWatcher, type AgentWatcherOptions, type SessionLocation } from './agentWatcher'
import { isSafeId, projectDirCandidates } from './subagentPaths'

const UPDATE_DEBOUNCE_MS = 250

/** Where a tab's transcripts live and which account owns them. */
export interface ResolvedSession extends SessionLocation {
  accountId: string
}

interface Deps {
  repo: Repository
  ipcTools: Pick<IpcTools, 'handle'>
  getWindow: () => BrowserWindow | null
  /** Tab → transcript location; defaults to the tab's project path under its account. */
  resolveSession?: (sessionId: string) => ResolvedSession | null
  /** Test queue run an agent waits on or runs (wired by the queue). */
  queuedRunId?: (sessionId: string, agentId: string) => string | undefined
  /** Timing and fs.watch switches (tests). */
  watcherOptions?: Pick<AgentWatcherOptions, 'timing' | 'watchFiles' | 'now'>
  updateDebounceMs?: number
}

export interface AgentsIpc {
  /**
   * Closes the file handles of every watched tab of the account (Windows locks watched folders);
   * call before its folder is deleted. Watches stay registered and locate again later.
   */
  forgetAccount(accountId: string): void
  /** Same for one tab (project moves, tab removal). */
  forgetSession(sessionId: string): void
  /** Drops every watch (renderer reload, main window closed). */
  reset(): void
  dispose(): void
}

interface Entry {
  refs: number
  watcher: AgentSessionWatcher
  /** Account of the last successful location; kept so forgetAccount works after removal. */
  accountId: string | null
  timer: NodeJS.Timeout | null
  lastSent: string
}

export function registerAgentsIpc({
  repo,
  ipcTools,
  getWindow,
  resolveSession,
  queuedRunId,
  watcherOptions,
  updateDebounceMs = UPDATE_DEBOUNCE_MS
}: Deps): AgentsIpc {
  const entries = new Map<string, Entry>()

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const defaultResolve = (sessionId: string): ResolvedSession | null => {
    const session = repo.session(sessionId)
    if (session.kind !== 'claude' || !session.claudeSessionId) return null
    const project = repo.project(session.projectId)
    const account = repo.account(project.accountId)
    return {
      accountId: account.id,
      claudeSessionId: session.claudeSessionId,
      projectDirs: projectDirCandidates(account.configDir, project.path)
    }
  }
  const resolve = resolveSession ?? defaultResolve

  /** A Claude tab that exists; shell tabs have no agents. */
  const claudeSession = (sessionId: unknown): string => {
    if (!isText(sessionId) || !isSafeId(sessionId)) throw new DomainError('INVALID')
    if (repo.session(sessionId).kind !== 'claude') throw new DomainError('INVALID')
    return sessionId
  }

  const agentArg = (agentId: unknown): string => {
    if (!isSafeId(agentId)) throw new DomainError('INVALID')
    return agentId
  }

  const watched = (sessionId: unknown): Entry => {
    const entry = isText(sessionId) ? entries.get(sessionId) : undefined
    if (!entry) throw new DomainError('NOT_FOUND')
    return entry
  }

  const pushUpdate = (sessionId: string, entry: Entry): void => {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (entries.get(sessionId) !== entry) return
      const summaries: AgentSummary[] = entry.watcher.summaries()
      const serialized = JSON.stringify(summaries)
      if (serialized === entry.lastSent) return
      entry.lastSent = serialized
      send(IPC.agentsUpdate, sessionId, summaries)
    }, updateDebounceMs)
  }

  const createEntry = (sessionId: string): Entry => {
    let entry: Entry | null = null
    const watcher = new AgentSessionWatcher({
      ...watcherOptions,
      locate: () => {
        let resolved: ResolvedSession | null
        try {
          resolved = resolve(sessionId)
        } catch {
          return null
        }
        if (resolved && entry) entry.accountId = resolved.accountId
        return resolved
      },
      onChange: () => {
        if (entry) pushUpdate(sessionId, entry)
      },
      onEvents: (agentId, events) => send(IPC.agentsEvents, sessionId, agentId, events),
      queuedRunId: queuedRunId ? (agentId) => queuedRunId(sessionId, agentId) : undefined
    })
    entry = { refs: 1, watcher, accountId: null, timer: null, lastSent: '[]' }
    return entry
  }

  const drop = (sessionId: string, entry: Entry): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.watcher.dispose()
    entries.delete(sessionId)
  }

  ipcTools.handle(IPC.agentsWatch, async (sessionId: unknown) => {
    const id = claudeSession(sessionId)
    const existing = entries.get(id)
    if (existing) {
      existing.refs++
      return existing.watcher.summaries()
    }
    const entry = createEntry(id)
    entries.set(id, entry)
    await entry.watcher.start()
    const summaries = entry.watcher.summaries()
    entry.lastSent = JSON.stringify(summaries)
    return summaries
  })

  ipcTools.handle(IPC.agentsUnwatch, (sessionId: unknown) => {
    if (!isText(sessionId)) throw new DomainError('INVALID')
    const entry = entries.get(sessionId)
    if (entry && --entry.refs <= 0) drop(sessionId, entry)
    return null
  })

  ipcTools.handle(IPC.agentsList, (sessionId: unknown) => {
    if (!isText(sessionId)) throw new DomainError('INVALID')
    return entries.get(sessionId)?.watcher.summaries() ?? []
  })

  ipcTools.handle(IPC.agentsOpen, (sessionId: unknown, agentId: unknown) =>
    watched(sessionId).watcher.open(agentArg(agentId))
  )

  ipcTools.handle(IPC.agentsClose, (sessionId: unknown, agentId: unknown) => {
    const id = agentArg(agentId)
    if (isText(sessionId)) entries.get(sessionId)?.watcher.close(id)
    return null
  })

  ipcTools.handle(IPC.agentsOlder, (sessionId: unknown, agentId: unknown, cursor: unknown) => {
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new DomainError('INVALID')
    }
    return watched(sessionId).watcher.older(agentArg(agentId), cursor)
  })

  const reset = (): void => {
    for (const [sessionId, entry] of [...entries]) drop(sessionId, entry)
  }

  return {
    forgetAccount(accountId) {
      for (const entry of entries.values()) {
        if (entry.accountId === accountId) entry.watcher.suspend()
      }
    },
    forgetSession(sessionId) {
      entries.get(sessionId)?.watcher.suspend()
    },
    reset,
    dispose: reset
  }
}
