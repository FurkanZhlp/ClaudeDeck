import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api'
import { IPC, type IpcResult } from '../shared/ipc'
import { optimizeSupported } from '../shared/optimizeSupport'

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
    remove: (id) => call(IPC.projectRemove, id),
    setTestQueue: (id, patch) => call(IPC.projectSetTestQueue, id, patch),
    setClaude: (id, patch) => call(IPC.projectSetClaude, id, patch),
    setGuard: (id, patch) => call(IPC.projectSetGuard, id, patch)
  },
  sessions: {
    create: (projectId, kind, title, permissionMode) =>
      call(IPC.sessionCreate, projectId, kind, title, permissionMode ?? null),
    rename: (id, title) => call(IPC.sessionRename, id, title),
    remove: (id) => call(IPC.sessionRemove, id),
    onOpenRequest: (cb) => subscribe(IPC.sessionOpenRequest, cb)
  },
  settings: {
    setLanguage: (language) => call(IPC.settingsSetLanguage, language),
    setUsage: (patch) => call(IPC.settingsSetUsage, patch),
    setLaunchAtLogin: (enabled) => call(IPC.settingsSetLaunchAtLogin, enabled),
    setTestQueue: (patch) => call(IPC.settingsSetTestQueue, patch),
    setClaude: (patch) => call(IPC.settingsSetClaude, patch),
    setGuard: (patch) => call(IPC.settingsSetGuard, patch)
  },
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
  mcp: { info: () => call(IPC.mcpInfo) },
  optimize: {
    start: (accountId) => call(IPC.optimizeStart, accountId),
    get: (accountId) => call(IPC.optimizeGet, accountId),
    list: () => call(IPC.optimizeList),
    answer: (accountId, questionId, decision, note) =>
      call(IPC.optimizeAnswer, accountId, questionId, decision, note),
    cancel: (accountId) => call(IPC.optimizeCancel, accountId),
    revert: (accountId) => call(IPC.optimizeRevert, accountId),
    onUpdate: (cb) => subscribe(IPC.optimizeUpdate, cb)
  },
  usage: {
    list: () => call(IPC.usageList),
    onUpdate: (cb) => subscribe(IPC.usageUpdate, cb),
    pollNow: (accountId) => call(IPC.usagePollNow, accountId),
    plans: () => call(IPC.usagePlans),
    stats: () => call(IPC.usageStats),
    onStats: (cb) => subscribe(IPC.usageStatsUpdate, cb)
  },
  testQueue: {
    list: () => call(IPC.testQueueList),
    onUpdate: (cb) => subscribe(IPC.testQueueUpdate, cb),
    cancel: (runId) => call(IPC.testQueueCancel, runId),
    move: (runId, position) => call(IPC.testQueueMove, runId, position),
    runNow: (runId) => call(IPC.testQueueRunNow, runId),
    release: (runId) => call(IPC.testQueueRelease, runId),
    stop: (runId) => call(IPC.testQueueStop, runId),
    classify: (command, projectId) => call(IPC.testQueueClassify, command, projectId),
    hookStatus: () => call(IPC.testQueueHookStatus),
    builtins: () => call(IPC.testQueueBuiltins)
  },
  guard: {
    rules: () => call(IPC.guardRules),
    evaluate: (request) => call(IPC.guardEvaluate, request),
    log: () => call(IPC.guardLog),
    onEvent: (cb) => subscribe(IPC.guardEvent, cb)
  },
  agents: {
    watch: (sessionId) => call(IPC.agentsWatch, sessionId),
    unwatch: (sessionId) => call(IPC.agentsUnwatch, sessionId),
    list: (sessionId) => call(IPC.agentsList, sessionId),
    open: (sessionId, agentId) => call(IPC.agentsOpen, sessionId, agentId),
    close: (sessionId, agentId) => call(IPC.agentsClose, sessionId, agentId),
    older: (sessionId, agentId, cursor) => call(IPC.agentsOlder, sessionId, agentId, cursor),
    onUpdate: (cb) => subscribe(IPC.agentsUpdate, cb),
    onEvents: (cb) => subscribe(IPC.agentsEvents, cb)
  },
  assistant: {
    start: (input) => call(IPC.assistantStart, input),
    followUp: (runId, text) => call(IPC.assistantFollowUp, runId, text),
    cancel: (runId) => call(IPC.assistantCancel, runId),
    apply: (proposalId, confirmed) => call(IPC.assistantApply, proposalId, confirmed),
    reject: (proposalId) => call(IPC.assistantReject, proposalId),
    undo: (token) => call(IPC.assistantUndo, token),
    onStatus: (cb) => subscribe(IPC.assistantStatus, cb),
    onProposal: (cb) => subscribe(IPC.assistantProposal, cb),
    onQuestion: (cb) => subscribe(IPC.assistantQuestion, cb),
    onDone: (cb) => subscribe(IPC.assistantDone, cb),
    onError: (cb) => subscribe(IPC.assistantError, cb)
  },
  app: {
    platform: process.platform,
    optimizeSupported: optimizeSupported(process.platform),
    setSelectedAccount: (accountId) => ipcRenderer.send(IPC.appSelectedAccount, accountId),
    trayAccount: () => call(IPC.appTrayAccount),
    openMain: () => call(IPC.appOpenMain),
    quit: () => call(IPC.appQuit),
    packaged: () => call(IPC.appPackaged),
    version: () => call(IPC.appVersion),
    checkUpdates: () => call(IPC.appCheckUpdates),
    onTrayShown: (cb) => subscribe(IPC.appTrayShown, cb),
    resizeTray: (height) => ipcRenderer.send(IPC.appTrayResize, height)
  }
}

contextBridge.exposeInMainWorld('api', api)
