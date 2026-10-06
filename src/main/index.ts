import { app, BrowserWindow, dialog, Menu, net, session, shell } from 'electron'
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
import type { UpdateInfo } from '../shared/types'
import icon from '../../resources/icon.png?asset'

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

const userData = app.getPath('userData')
const accountsRoot = join(userData, 'accounts')
const repo = new Repository(new JsonStore(join(userData, 'config.json'), emptyState), accountsRoot)
const accounts = new AccountService(accountsRoot, resolveShellEnv)

let mainWindow: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  data: (id, data) => send(IPC.ptyData, id, data),
  exit: (id, exitCode) => send(IPC.ptyExit, id, exitCode)
})

const translator = (): Translate =>
  createTranslator(resolveLanguage(repo.get().settings.language, app.getLocale()))

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
  win.webContents.on('did-finish-load', () => ptys.killAll())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.furkanzhlp.claudedeck')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Kamera, mikrofon, bildirim gibi izinlere ihtiyaç yok.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  registerIpc({
    repo,
    accounts,
    ptys,
    getWindow: () => mainWindow,
    onLanguageChange: applyMenu,
    checkUpdate: checkUpdateQuietly,
    openUpdate: openUpdatePage
  })
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
app.on('before-quit', () => ptys.killAll())
