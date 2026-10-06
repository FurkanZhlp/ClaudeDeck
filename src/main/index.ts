import { app, BrowserWindow, dialog, Menu, net, session, shell } from 'electron'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc'
import { resolveLanguage } from '../shared/language'
import { createTranslator, type Translate } from '../shared/translate'
import { AccountService } from './accounts/accountService'
import { resolveShellEnv } from './env/shellEnv'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { PtyManager } from './pty/ptyManager'
import { JsonStore } from './state/jsonStore'
import { emptyState, Repository } from './state/repository'
import { checkForUpdate, RELEASES_URL } from './updates/updateChecker'
import type { Account, GuidelinesUpdate, McpInfo, UpdateInfo } from '../shared/types'
import icon from '../../resources/icon.png?asset'
import guidelinesText from '../../resources/claudedeck/guidelines.md?raw'
import optimizePrompt from '../../resources/claudedeck/optimize-prompt.md?raw'
import { createIpcTools } from './ipcUtil'
import { registerMcpInConfig, unregisterMcpInConfig } from './mcp/register'
import { createSessionTokens } from './mcp/sessionTokens'
import { createOptimizeTools } from './mcp/optimizeTools'
import { OptimizeManager } from './optimize/optimizeManager'
import { registerOptimizeIpc } from './optimize/optimizeIpc'
import { registerUsageIpc } from './usage/usageIpc'
import { createUsageService } from './usage/usageWatcher'
import { createUsagePoller } from './usage/usagePoller'
import { registerStatsIpc } from './stats/statsIpc'
import { createStatsService } from './stats/statsService'
import { registerMcpIpc } from './mcp/mcpIpc'
import { startMcpServer } from './mcp/server'
import { createTools, type ConfirmRequest } from './mcp/tools'
import { registerNotesIpc, type NotesIpc } from './notes/notesIpc'
import { listNotes, readNote, writeNote } from './notes/notesStore'
import { ensureGuidelines } from './profile/guidelines'
import { registerProfileIpc } from './profile/profileIpc'

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

const userData = app.getPath('userData')
const accountsRoot = join(userData, 'accounts')
const repo = new Repository(new JsonStore(join(userData, 'config.json'), emptyState), accountsRoot)
const accounts = new AccountService(accountsRoot, resolveShellEnv)
// Plan usage reported by Claude Code through a statusline hook installed per account.
const usage = createUsageService({ repo, userDataDir: userData, send })
// Tokens and API-equivalent cost from each account's local transcripts.
const stats = createStatsService({ repo, send })
// Background `claude -p /usage` checks (no model call) keep usage fresh between Claude runs.
const usagePoller = createUsagePoller({
  repo,
  baseEnv: resolveShellEnv,
  claudeAvailable: () => accounts.claudeAvailable(),
  onUsage: (reading) => usage.ingest(reading)
})

let mainWindow: BrowserWindow | null = null
let notes: NotesIpc | null = null
let mcp: { url: string; stop: () => Promise<void> } | null = null
// Per-tab MCP tokens; each Claude tab only reaches its own project.
const mcpTokens = createSessionTokens()
// Guideline upgrades found before the window loaded; shown once the renderer is ready.
let pendingGuidelineUpdates: GuidelinesUpdate[] = []

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  data: (id, data) => send(IPC.ptyData, id, data),
  exit: (id, exitCode) => {
    mcpTokens.revoke(id)
    send(IPC.ptyExit, id, exitCode)
  }
})

// Headless profile optimization runs; they outlive the renderer and talk to Claude via MCP.
const optimize = new OptimizeManager({
  account: (id) => repo.account(id),
  claudeAvailable: () => accounts.claudeAvailable(),
  baseEnv: resolveShellEnv,
  tokens: mcpTokens,
  mcpUrl: () => mcp?.url ?? null,
  prompt: optimizePrompt,
  guidelinesText,
  emit: (state) => send(IPC.optimizeUpdate, state),
  onGuidelinesUpdated: (update) => send(IPC.profileGuidelinesUpdated, update)
})

const translator = (): Translate =>
  createTranslator(resolveLanguage(repo.get().settings.language, app.getLocale()))

/** Installs the bundled guidelines and the ClaudeDeck MCP entry into an account's profile. */
function prepareAccount(account: Account): void {
  try {
    const upgrade = ensureGuidelines(account.configDir, guidelinesText)
    if (upgrade && upgrade.from !== null) {
      const update: GuidelinesUpdate = { accountId: account.id, ...upgrade }
      // Live while the UI is up; otherwise the renderer pulls it once it has loaded.
      if (mainWindow?.webContents.isLoading() === false) send(IPC.profileGuidelinesUpdated, update)
      else pendingGuidelineUpdates.push(update)
    }
  } catch (error) {
    console.warn('[profile] guidelines', account.id, error)
  }
  try {
    // Without a running server the entry would only show a failing MCP server in Claude.
    if (mcp) registerMcpInConfig(account.configDir, mcp.url)
    else unregisterMcpInConfig(account.configDir)
  } catch (error) {
    console.warn('[mcp] could not update registration for account', account.id, error)
  }
  try {
    usage.prepareAccount(account)
  } catch (error) {
    console.warn('[usage] could not prepare account', account.id, error)
  }
}

/** Native confirmation for MCP actions that change the app; Cancel is the default. */
async function confirmMcpRequest(request: ConfirmRequest): Promise<boolean> {
  const t = translator()
  const state = repo.get()
  const requester = state.projects.find((p) => p.id === request.requestedBy.projectId)
  const account = state.accounts.find((a) => a.id === request.requestedBy.accountId)
  let message: string
  if (request.kind === 'create_project') {
    message = t('mcp.confirmCreateProject', { name: request.name, path: request.path })
  } else {
    const project = state.projects.find((p) => p.id === request.projectId)
    message = t(
      request.sessionKind === 'claude' ? 'mcp.confirmOpenClaude' : 'mcp.confirmOpenShell',
      {
        project: project?.name ?? ''
      }
    )
  }
  const options = {
    type: 'question' as const,
    buttons: [t('mcp.allow'), t('common.cancel')],
    defaultId: 1,
    cancelId: 1,
    message,
    detail: t('mcp.requestedBy', { project: requester?.name ?? '', account: account?.name ?? '' })
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

async function startMcp(): Promise<void> {
  const tools = createTools({
    repo,
    notes: { list: listNotes, read: readNote, write: writeNote },
    requestOpenSession: (sessionId) => send(IPC.sessionOpenRequest, sessionId),
    notifyStateChanged: () => send(IPC.stateChanged, repo.get()),
    confirm: confirmMcpRequest
  })
  // Older builds stored a long-lived token here; tokens are per tab and in memory now.
  rmSync(join(userData, 'mcp.json'), { force: true })
  try {
    mcp = await startMcpServer({
      tools: { ...tools, ...createOptimizeTools(optimize.port) },
      tokens: mcpTokens,
      version: app.getVersion()
    })
  } catch (error) {
    console.error('[mcp] server did not start', error)
    mcp = null
  }
  repo.get().accounts.forEach(prepareAccount)
}

function applyMenu(): void {
  const t = translator()
  Menu.setApplicationMenu(
    buildMenu(t, {
      dev: is.dev,
      openSettings: () => send(IPC.menuOpenSettings),
      checkUpdates: () => void checkUpdatesManually()
    })
  )
}

let lastUpdate: UpdateInfo | null = null

async function fetchUpdate(): Promise<UpdateInfo> {
  lastUpdate = await checkForUpdate(app.getVersion(), net.fetch as typeof fetch)
  return lastUpdate
}

/** Arka plan denetimi: yalnızca paketlenmiş sürümde, hatalar sessizce yutulur. */
async function checkUpdateQuietly(): Promise<UpdateInfo | null> {
  if (!app.isPackaged) return null
  try {
    const info = await fetchUpdate()
    if (info.available) send(IPC.updateAvailable, info)
    return info
  } catch (error) {
    console.warn('[update]', error)
    return null
  }
}

async function openUpdatePage(): Promise<void> {
  await shell.openExternal(lastUpdate?.url ?? RELEASES_URL)
}

async function checkUpdatesManually(): Promise<void> {
  const t = translator()
  const show = (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)
  try {
    const info = await fetchUpdate()
    if (!info.available) {
      await show({ type: 'info', message: t('update.upToDate', { version: info.currentVersion }) })
      return
    }
    send(IPC.updateAvailable, info)
    const { response } = await show({
      type: 'info',
      buttons: [t('update.download'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1,
      message: t('update.available', { version: info.latestVersion ?? '' }),
      detail: t('update.current', { version: info.currentVersion })
    })
    if (response === 0) await openUpdatePage()
  } catch {
    await show({ type: 'warning', message: t('update.failed') })
  }
}

/** Terminal çıktısındaki linkler aldatıcı olabilir; tam adresi gösterip onay alır. */
async function confirmOpenExternal(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
  if (raw.length > 2048) return
  // The sign-in flow links to Anthropic's own domains; open those without a prompt.
  const trusted = ['claude.com', 'claude.ai', 'anthropic.com'].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
  )
  if (trusted && url.protocol === 'https:') {
    await shell.openExternal(url.toString())
    return
  }
  const t = translator()
  const options = {
    type: 'question' as const,
    buttons: [t('link.open'), t('common.cancel')],
    defaultId: 0,
    cancelId: 1,
    message: t('link.confirm', { host: url.host }),
    detail: url.toString()
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  if (response === 0) await shell.openExternal(url.toString())
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('focus', () => usagePoller.pollSoon())
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void confirmOpenExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  // Renderer yeniden yüklenince terminal görünümleri kaybolur; sahipsiz süreç bırakma.
  win.webContents.on('did-finish-load', () => {
    ptys.killAll()
    // Optimization runs keep going across reloads; only tab tokens die with their tabs.
    mcpTokens.revokeAll('session')
    notes?.reset()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One instance only: a second copy would fight over the MCP port and every account's .claude.json.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.furkanzhlp.claudedeck')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Only clipboard writes are needed (copying the sign-in link); deny everything else.
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write'
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(allowed(permission))
  )
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    allowed(permission)
  )

  registerIpc({
    repo,
    accounts,
    ptys,
    getWindow: () => mainWindow,
    onLanguageChange: applyMenu,
    checkUpdate: checkUpdateQuietly,
    openUpdate: openUpdatePage,
    prepareAccount,
    onProjectMoved: (before, after, projectId) => {
      try {
        notes?.relocateForProjectChange(before, after, projectId)
      } catch (error) {
        console.error('[notes] could not move project notes', error)
      }
    },
    prepareProjectMemory: (projectId) => {
      try {
        notes?.prepareProjectMemory(projectId)
      } catch (error) {
        console.error('[notes] could not prepare project notes', error)
      }
    },
    issueMcpToken: (scope) => mcpTokens.issue(scope),
    revokeMcpTokens: (sessionIds) => sessionIds.forEach((id) => mcpTokens.revoke(id)),
    cancelOptimize: (accountId) => {
      if (optimize.isActive(accountId)) void optimize.cancel(accountId)
    }
  })
  const ipcTools = createIpcTools(() => mainWindow)
  notes = registerNotesIpc({
    handle: ipcTools.handle,
    repo,
    send,
    isProjectRunning: (projectId) =>
      repo.get().sessions.some((s) => s.projectId === projectId && ptys.has(s.id))
  })
  registerProfileIpc({
    handle: ipcTools.handle,
    repo,
    ptys,
    accounts,
    globalDir: join(homedir(), '.claude'),
    isOptimizing: (accountId) => optimize.isActive(accountId),
    takePendingGuidelineUpdates: () => {
      const updates = pendingGuidelineUpdates
      pendingGuidelineUpdates = []
      return updates
    }
  })
  registerOptimizeIpc({ handle: ipcTools.handle, manager: optimize })
  registerUsageIpc({ handle: ipcTools.handle, service: usage, poller: usagePoller, repo })
  registerStatsIpc({ handle: ipcTools.handle, service: stats })
  registerMcpIpc({
    handle: ipcTools.handle,
    getInfo: (): McpInfo => ({ running: mcp !== null, url: mcp?.url ?? null })
  })
  void startMcp()
  applyMenu()
  void resolveShellEnv()
  createWindow()
  usagePoller.start()
  setInterval(() => void checkUpdateQuietly(), UPDATE_INTERVAL_MS)
  // Geliştirme modunda Dock'ta Electron yerine uygulama ikonu görünsün.
  if (is.dev) app.dock?.setIcon(icon)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  ptys.killAll()
  optimize.disposeAll()
  usagePoller.stop()
  usage.dispose()
  stats.dispose()
  mcpTokens.revokeAll()
  notes?.dispose()
  void mcp?.stop()
})
