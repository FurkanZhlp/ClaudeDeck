import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc'
import { resolveLanguage } from '../shared/language'
import { createTranslator } from '../shared/translate'
import { AccountService } from './accounts/accountService'
import { resolveShellEnv } from './env/shellEnv'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { PtyManager } from './pty/ptyManager'
import { JsonStore } from './state/jsonStore'
import { emptyState, Repository } from './state/repository'

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

function applyMenu(): void {
  const t = createTranslator(resolveLanguage(repo.get().settings.language, app.getLocale()))
  Menu.setApplicationMenu(
    buildMenu(t, { dev: is.dev, openSettings: () => send(IPC.menuOpenSettings) })
  )
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
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

  registerIpc({ repo, accounts, ptys, getWindow: () => mainWindow, onLanguageChange: applyMenu })
  applyMenu()
  void resolveShellEnv()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => ptys.killAll())
