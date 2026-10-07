import { app, BrowserWindow, dialog, Menu, nativeTheme, net, session, shell } from 'electron'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc'
import { resolveLanguage } from '../shared/language'
import { createTranslator, type Translate } from '../shared/translate'
import { AccountService } from './accounts/accountService'
import { platform } from './platform'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { PtyManager } from './pty/ptyManager'
import { JsonStore } from './state/jsonStore'
import { emptyState, Repository } from './state/repository'
import { checkForUpdate, RELEASES_URL } from './updates/updateChecker'
import type { Account, GuidelinesUpdate, McpInfo, UpdateInfo } from '../shared/types'
import icon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/trayTemplate.png?asset'
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
import { registerAppIpc } from './tray/appIpc'
import { createMenuBar, type MenuBar } from './tray/menuBar'
import { TRAY_CHANNELS } from './tray/trayChannels'
import { loginItemSettings, wasOpenedAtLogin } from './window/loginItem'
import { titleBarOverlay, windowBackground, windowChrome } from './window/windowChrome'

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

const userData = app.getPath('userData')
const accountsRoot = join(userData, 'accounts')
const repo = new Repository(new JsonStore(join(userData, 'config.json'), emptyState), accountsRoot)
const accounts = new AccountService(accountsRoot, platform.resolveBaseEnv)
// Plan usage reported by Claude Code through a statusline hook installed per account.
const usage = createUsageService({
  repo,
  userDataDir: userData,
  send: (channel, ...args) => {
    broadcast(channel, ...args)
    if (channel === IPC.usageUpdate) menuBar?.refresh()
  }
})
// Tokens and API-equivalent cost from each account's local transcripts.
const stats = createStatsService({ repo, send: broadcast })
// Background `claude -p /usage` checks (no model call) keep usage fresh between Claude runs.
const usagePoller = createUsagePoller({
  repo,
  baseEnv: platform.resolveBaseEnv,
  claudeAvailable: () => accounts.claudeAvailable(),
  onUsage: (reading) => usage.ingest(reading)
})

let mainWindow: BrowserWindow | null = null
// macOS menu bar item with a usage popover; null until the app is ready or when turned off.
let menuBar: MenuBar | null = null
// Account selected in the main window, for the menu bar's 'selected' mode.
let selectedAccountId: string | null = null
let quitting = false
let notes: NotesIpc | null = null
let mcp: { url: string; stop: () => Promise<void> } | null = null
// Per-tab MCP tokens; each Claude tab only reaches its own project.
const mcpTokens = createSessionTokens()
// Guideline upgrades found before the window loaded; shown once the renderer is ready.
let pendingGuidelineUpdates: GuidelinesUpdate[] = []

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

/** Events both renderers mirror (usage, state); terminal traffic stays with `send`. */
function broadcast(channel: string, ...args: unknown[]): void {
  send(channel, ...args)
  menuBar?.send(channel, ...args)
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
  baseEnv: platform.resolveBaseEnv,
  tokens: mcpTokens,
  mcpUrl: () => mcp?.url ?? null,
  prompt: optimizePrompt,
  guidelinesText,
  emit: (state) => send(IPC.optimizeUpdate, state),
  onGuidelinesUpdated: (update) => send(IPC.profileGuidelinesUpdated, update)
})

/** Registers or removes ClaudeDeck as a login item; only meaningful for the packaged app. */
function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings(loginItemSettings(process.platform, enabled))
  } catch (error) {
    console.warn('[login-item]', error)
  }
}

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
    notifyStateChanged: () => broadcast(IPC.stateChanged, repo.get()),
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
  // Windows: no menu bar, so its accelerators (Ctrl+C, Ctrl+V) never clash with the terminal.
  // Settings (Ctrl+,), updates and the version are reached from the renderer instead.
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null)
    return
  }
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

/** Loads the renderer, optionally at a hash route (e.g. the menu bar popover). */
function loadRenderer(win: BrowserWindow, hash = ''): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL']
    void win.loadURL(hash ? `${url}#${hash}` : url)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

/**
 * Brings the main window back, creating it again after it was closed. The Dock icon comes back
 * first: a window shown while the app is still a menu bar only app would not take focus.
 */
async function showMainWindow(): Promise<void> {
  menuBar?.hidePopover()
  try {
    await app.dock?.show()
  } catch (error) {
    console.warn('[dock]', error)
  }
  app.focus({ steal: true })
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Main window closed while the menu bar keeps the app alive: free what only it used. */
function onMainWindowClosed(): void {
  mainWindow = null
  if (quitting) return
  if (!menuBar?.enabled()) {
    app.quit()
    return
  }
  // The terminal views are gone with the window; leave no orphaned processes behind.
  ptys.killAll()
  mcpTokens.revokeAll('session')
  notes?.reset()
  app.dock?.hide()
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    ...windowChrome(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('focus', () => usagePoller.pollSoon())
  win.on('closed', onMainWindowClosed)
  if (process.platform === 'win32') {
    // The caption buttons and the window background follow the system light or dark theme.
    const syncTheme = (): void => {
      if (win.isDestroyed()) return
      const dark = nativeTheme.shouldUseDarkColors
      win.setTitleBarOverlay(titleBarOverlay(dark))
      win.setBackgroundColor(windowBackground(dark))
    }
    nativeTheme.on('updated', syncTheme)
    win.on('closed', () => nativeTheme.off('updated', syncTheme))
  }
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

  loadRenderer(win)
}

// One instance only: a second copy would fight over the MCP port and every account's .claude.json.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) void showMainWindow()
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

  // The main window may call every handler; the popover only what its view needs.
  const ipcTools = createIpcTools({
    main: () => mainWindow?.webContents,
    tray: () => menuBar?.popoverContents(),
    trayChannels: TRAY_CHANNELS
  })
  menuBar = createMenuBar({
    iconPath: trayIcon,
    preloadPath: join(__dirname, '../preload/index.js'),
    loadRenderer,
    settings: () => repo.get().settings.usage,
    accounts: () => repo.get().accounts,
    usage: () => usage.list(),
    selectedAccount: () => selectedAccountId,
    language: () => resolveLanguage(repo.get().settings.language, app.getLocale()),
    translate: translator,
    openMain: () => void showMainWindow(),
    quit: () => app.quit(),
    onPopoverShown: () => usagePoller.pollSoon()
  })
  // Settings and account names shown in the popover follow changes made in the main window.
  const syncMenuBar = (): void => {
    menuBar?.sync()
    menuBar?.send(IPC.stateChanged, repo.get())
  }

  registerIpc({
    repo,
    accounts,
    ptys,
    getWindow: () => mainWindow,
    ipcTools,
    onLanguageChange: () => {
      applyMenu()
      syncMenuBar()
    },
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
    onUsageSettingsChange: syncMenuBar,
    onAccountsChange: syncMenuBar,
    // Called on account removal before its folder is deleted (an open watcher blocks rm on Windows).
    forgetUsage: (accountId) => usage.forget(accountId),
    applyLaunchAtLogin,
    cancelOptimize: (accountId) => {
      if (optimize.isActive(accountId)) void optimize.cancel(accountId)
    }
  })
  registerAppIpc({
    handle: ipcTools.handle,
    isMainSender: ipcTools.trusted,
    setSelectedAccount: (accountId) => {
      if (accountId === selectedAccountId) return
      selectedAccountId = accountId
      menuBar?.refresh()
    },
    trayAccount: () => menuBar?.account() ?? null,
    openMain: () => void showMainWindow(),
    quit: () => app.quit(),
    packaged: () => app.isPackaged,
    version: () => app.getVersion(),
    checkUpdates: () => void checkUpdatesManually()
  })
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
  void platform.resolveBaseEnv()
  // Keep the login item in sync with the saved choice (e.g. after the app was moved or reinstalled).
  applyLaunchAtLogin(repo.get().settings.launchAtLogin)
  menuBar.sync()
  // Opened at login with the menu bar on: stay in the menu bar until the user asks for the window.
  if (startsHidden()) app.dock?.hide()
  else createWindow()
  usagePoller.start()
  setInterval(() => void checkUpdateQuietly(), UPDATE_INTERVAL_MS)
  // Geliştirme modunda Dock'ta Electron yerine uygulama ikonu görünsün.
  if (is.dev) app.dock?.setIcon(icon)

  // The popover window may still exist, so only the main window counts here.
  app.on('activate', () => {
    if (!mainWindow) void showMainWindow()
  })
})

/** Whether this launch came from the login item and the menu bar can host the app. */
function startsHidden(): boolean {
  const { launchAtLogin, usage: usageSettings } = repo.get().settings
  if (!app.isPackaged || !launchAtLogin || !usageSettings.trayEnabled || !menuBar?.enabled()) {
    return false
  }
  return wasOpenedAtLogin(process.platform, process.argv, () => app.getLoginItemSettings())
}

app.on('window-all-closed', () => {
  if (!menuBar?.enabled()) app.quit()
})
app.on('before-quit', () => {
  quitting = true
  menuBar?.dispose()
  ptys.killAll()
  optimize.disposeAll()
  usagePoller.stop()
  usage.dispose()
  stats.dispose()
  mcpTokens.revokeAll()
  notes?.dispose()
  void mcp?.stop()
})
