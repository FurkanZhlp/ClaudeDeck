import { app, BrowserWindow, dialog, Menu, net, session, shell } from 'electron'
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
import { registerMcpInConfig } from './mcp/register'
import { registerMcpIpc } from './mcp/mcpIpc'
import { startMcpServer } from './mcp/server'
import { createTools } from './mcp/tools'
import { registerNotesIpc, type NotesIpc } from './notes/notesIpc'
import { listNotes, readNote, writeNote } from './notes/notesStore'
import { ensureGuidelines } from './profile/guidelines'
import { registerProfileIpc } from './profile/profileIpc'

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

const userData = app.getPath('userData')
const accountsRoot = join(userData, 'accounts')
const repo = new Repository(new JsonStore(join(userData, 'config.json'), emptyState), accountsRoot)
const accounts = new AccountService(accountsRoot, resolveShellEnv)

let mainWindow: BrowserWindow | null = null
let notes: NotesIpc | null = null
let mcp: { url: string; token: string; stop: () => Promise<void> } | null = null
// Guideline upgrades found before the window loaded; shown once the renderer is ready.
let pendingGuidelineUpdates: GuidelinesUpdate[] = []

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  data: (id, data) => send(IPC.ptyData, id, data),
  exit: (id, exitCode) => send(IPC.ptyExit, id, exitCode)
})

const translator = (): Translate =>
  createTranslator(resolveLanguage(repo.get().settings.language, app.getLocale()))

/** Installs the bundled guidelines and the ClaudeDeck MCP entry into an account's profile. */
function prepareAccount(account: Account): void {
  try {
    const upgrade = ensureGuidelines(account.configDir, guidelinesText)
    if (upgrade && upgrade.from !== null) {
      const update: GuidelinesUpdate = { accountId: account.id, ...upgrade }
      if (mainWindow?.webContents.isLoading() === false) send(IPC.profileGuidelinesUpdated, update)
      else pendingGuidelineUpdates.push(update)
    }
  } catch (error) {
    console.warn('[profile] guidelines', account.id, error)
  }
  if (!mcp) return
  try {
    registerMcpInConfig(account.configDir, mcp.url, mcp.token)
  } catch (error) {
    console.warn('[mcp] could not register for account', account.id, error)
  }
}

async function startMcp(): Promise<void> {
  const tools = createTools({
    repo,
    notes: { list: listNotes, read: readNote, write: writeNote },
    requestOpenSession: (sessionId) => send(IPC.sessionOpenRequest, sessionId),
    notifyStateChanged: () => send(IPC.stateChanged, repo.get())
  })
  try {
    mcp = await startMcpServer({
      tools,
      tokenFile: join(userData, 'mcp.json'),
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
    pendingGuidelineUpdates.forEach((update) => send(IPC.profileGuidelinesUpdated, update))
    pendingGuidelineUpdates = []
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
    onProjectMoved: (before, after) => {
      try {
        notes?.relocateForProjectChange(before, after)
      } catch (error) {
        console.error('[notes] could not move project notes', error)
      }
    }
  })
  const ipcTools = createIpcTools(() => mainWindow)
  notes = registerNotesIpc({ handle: ipcTools.handle, repo, send })
  registerProfileIpc({
    handle: ipcTools.handle,
    repo,
    ptys,
    accounts,
    send,
    globalDir: join(homedir(), '.claude'),
    guidelinesText,
    optimizePrompt
  })
  registerMcpIpc({
    handle: ipcTools.handle,
    getInfo: (): McpInfo => ({ running: mcp !== null, url: mcp?.url ?? null })
  })
  void startMcp()
  applyMenu()
  void resolveShellEnv()
  createWindow()
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
  notes?.dispose()
  void mcp?.stop()
})
