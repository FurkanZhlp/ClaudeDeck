import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api'
import { IPC, type IpcResult } from '../shared/ipc'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.code)
  return result.data
}

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  state: {
    get: () => call(IPC.stateGet),
    onChanged: (cb) => subscribe(IPC.stateChanged, cb)
  },
  accounts: {
    create: (input) => call(IPC.accountCreate, input),
    update: (id, patch) => call(IPC.accountUpdate, id, patch),
    remove: (id, deleteFiles) => call(IPC.accountRemove, id, deleteFiles),
    status: (id) => call(IPC.accountStatus, id)
  },
  projects: {
    create: (input) => call(IPC.projectCreate, input),
    update: (id, patch) => call(IPC.projectUpdate, id, patch),
    remove: (id) => call(IPC.projectRemove, id)
  },
  sessions: {
    create: (projectId, kind, title) => call(IPC.sessionCreate, projectId, kind, title),
    rename: (id, title) => call(IPC.sessionRename, id, title),
    remove: (id) => call(IPC.sessionRemove, id),
    onOpenRequest: (cb) => subscribe(IPC.sessionOpenRequest, cb)
  },
  settings: { setLanguage: (language) => call(IPC.settingsSetLanguage, language) },
  pty: {
    startSession: (sessionId, resume, cols, rows) =>
      call(IPC.ptyStartSession, sessionId, resume, cols, rows),
    startLogin: (accountId, cols, rows) => call(IPC.ptyStartLogin, accountId, cols, rows),
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id) => call(IPC.ptyKill, id),
    onData: (cb) => subscribe(IPC.ptyData, cb),
    onExit: (cb) => subscribe(IPC.ptyExit, cb)
  },
  system: {
    pickFolder: () => call(IPC.systemPickFolder),
    pathExists: (path) => call(IPC.systemPathExists, path),
    claudeAvailable: () => call(IPC.systemClaudeAvailable),
    onOpenSettings: (cb) => subscribe(IPC.menuOpenSettings, cb)
  },
  update: {
    check: () => call(IPC.updateCheck),
    open: () => call(IPC.updateOpen),
    onAvailable: (cb) => subscribe(IPC.updateAvailable, cb)
  },
  profile: {
    summarize: (source) => call(IPC.profileSummarize, source),
    diff: (accountId, source) => call(IPC.profileDiff, accountId, source),
    import: (accountId, source, categories) =>
      call(IPC.profileImport, accountId, source, categories),
    startOptimize: (accountId, cols, rows) => call(IPC.profileStartOptimize, accountId, cols, rows),
    openFolder: (accountId) => call(IPC.profileOpenFolder, accountId),
    onGuidelinesUpdated: (cb) => subscribe(IPC.profileGuidelinesUpdated, cb),
    takeGuidelineUpdates: () => call(IPC.profileTakeGuidelineUpdates)
  },
  notes: {
    list: (projectId) => call(IPC.notesList, projectId),
    read: (projectId, name) => call(IPC.notesRead, projectId, name),
    watch: (projectId) => call(IPC.notesWatch, projectId),
    unwatch: (projectId) => call(IPC.notesUnwatch, projectId),
    onChanged: (cb) => subscribe(IPC.notesChanged, cb),
    open: (projectId, name) => call(IPC.notesOpen, projectId, name),
    reveal: (projectId) => call(IPC.notesReveal, projectId)
  },
  mcp: { info: () => call(IPC.mcpInfo) }
}

contextBridge.exposeInMainWorld('api', api)
