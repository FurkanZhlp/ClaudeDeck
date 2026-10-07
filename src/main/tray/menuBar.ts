import {
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
  type WebContents
} from 'electron'
import { IPC } from '../../shared/ipc'
import type { Account, AccountUsage, UsageSettings } from '../../shared/types'
import type { Translate } from '../../shared/translate'
import { popoverBounds, requestedPopoverHeight } from './popoverBounds'
import { pickTrayAccount, trayTitle } from './trayTitle'

/** Starting size; the renderer then asks for the height its content needs. */
const POPOVER_SIZE = { width: 360, height: 560 }
const POPOVER_BG = { light: '#ffffff', dark: '#242421' }
/** Countdowns and rolled-over windows change the title even without new readings. */
const TICK_MS = 60_000
/**
 * Clicking the icon while the popover is open first blurs (hides) it; a click this soon after
 * that hide is the same gesture and must not open it again.
 */
const REOPEN_GUARD_MS = 250
/** Route the renderer shows inside the popover. */
export const TRAY_ROUTE = 'tray'

interface Deps {
  /** Template image path (black plus alpha); its `@2x` sibling is picked up automatically. */
  iconPath: string
  preloadPath: string
  /** Loads the renderer into the window at the given hash route. */
  loadRenderer: (win: BrowserWindow, hash: string) => void
  settings: () => UsageSettings
  accounts: () => Account[]
  usage: () => AccountUsage[]
  selectedAccount: () => string | null
  language: () => string
  translate: () => Translate
  openMain: () => void
  quit: () => void
  /** The popover opened; a good moment to refresh stale readings. */
  onPopoverShown: () => void
  now?: () => number
}

export interface MenuBar {
  /** Creates or removes the menu bar item to match the settings, then refreshes it. */
  sync(): void
  /** Re-renders the title (and context menu) from the current usage and settings. */
  refresh(): void
  enabled(): boolean
  /** Account the menu bar shows. */
  account(): string | null
  /** The popover's renderer, trusted for IPC like the main window. */
  popoverContents(): WebContents | null
  /** Sends an event to the popover renderer when it exists. */
  send(channel: string, ...args: unknown[]): void
  hidePopover(): void
  dispose(): void
}

export function createMenuBar(deps: Deps): MenuBar {
  const now = deps.now ?? Date.now
  let tray: Tray | null = null
  let popover: BrowserWindow | null = null
  let ticker: NodeJS.Timeout | null = null
  let hiddenAt = 0
  let popoverSize = POPOVER_SIZE

  const account = (): string | null =>
    pickTrayAccount(
      deps.accounts(),
      deps.usage(),
      deps.settings().trayAccount,
      deps.selectedAccount(),
      now()
    )

  const hidePopover = (): void => {
    if (popover && !popover.isDestroyed() && popover.isVisible()) {
      popover.hide()
      hiddenAt = Date.now()
    }
  }

  const createPopover = (): BrowserWindow => {
    const win = new BrowserWindow({
      ...POPOVER_SIZE,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: true,
      // Same as the renderer's --elevated token, so the popover does not flash white first.
      backgroundColor: nativeTheme.shouldUseDarkColors ? POPOVER_BG.dark : POPOVER_BG.light,
      webPreferences: {
        preload: deps.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // Opens on the current Space and over full screen apps, like a native menu bar popover.
    // skipTransformProcessType: without it Electron calls app.dock.hide() here, which
    // would drop the Dock icon while the main window is open. While the Dock is hidden the app
    // already is a UI element, which is what showing over full screen apps needs.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.on('blur', hidePopover)
    win.on('closed', () => {
      if (popover === win) popover = null
    })
    // Listened to on this window's own IPC, so no other renderer (or subframe) can resize it.
    win.webContents.ipc.on(IPC.appTrayResize, (event, value: unknown) => {
      if (event.senderFrame !== win.webContents.mainFrame) return
      const height = requestedPopoverHeight(value)
      if (height === null || height === popoverSize.height) return
      popoverSize = { ...popoverSize, height }
      if (win.isVisible()) placePopover(win)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== win.webContents.getURL()) event.preventDefault()
    })
    deps.loadRenderer(win, TRAY_ROUTE)
    return win
  }

  /** Puts the popover under the menu bar icon at its current size. */
  function placePopover(win: BrowserWindow): void {
    if (!tray) return
    const trayBounds = tray.getBounds()
    const { workArea } = screen.getDisplayMatching(trayBounds)
    win.setBounds(popoverBounds(trayBounds, workArea, popoverSize))
  }

  const showPopover = (): void => {
    if (!tray) return
    const reopened = !!popover && !popover.isDestroyed()
    if (!popover || popover.isDestroyed()) popover = createPopover()
    placePopover(popover)
    popover.show()
    popover.focus()
    // A new popover loads its state on mount; a reused one is told to refresh.
    if (reopened) popover.webContents.send(IPC.appTrayShown)
    deps.onPopoverShown()
  }

  const togglePopover = (): void => {
    if (popover && !popover.isDestroyed() && popover.isVisible()) return hidePopover()
    if (Date.now() - hiddenAt < REOPEN_GUARD_MS) return
    showPopover()
  }

  const contextMenu = (): Menu => {
    const t = deps.translate()
    return Menu.buildFromTemplate([
      { label: t('tray.open'), click: deps.openMain },
      { type: 'separator' },
      { label: t('menu.quit'), click: deps.quit }
    ])
  }

  const refresh = (): void => {
    if (!tray) return
    const { trayMetric, display } = deps.settings()
    const id = account()
    const usage = id ? deps.usage().find((u) => u.accountId === id) : undefined
    tray.setTitle(trayTitle(usage, trayMetric, display, deps.language(), now()), {
      fontType: 'monospacedDigit'
    })
    tray.setToolTip(deps.accounts().find((a) => a.id === id)?.name ?? 'ClaudeDeck')
  }

  const create = (): void => {
    const image = nativeImage.createFromPath(deps.iconPath)
    image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setIgnoreDoubleClickEvents(true)
    tray.on('click', togglePopover)
    tray.on('right-click', () => {
      hidePopover()
      tray?.popUpContextMenu(contextMenu())
    })
    ticker = setInterval(refresh, TICK_MS)
  }

  const destroy = (): void => {
    if (ticker) clearInterval(ticker)
    ticker = null
    if (popover && !popover.isDestroyed()) popover.destroy()
    popover = null
    tray?.destroy()
    tray = null
  }

  return {
    sync() {
      const wanted = process.platform === 'darwin' && deps.settings().trayEnabled
      if (wanted && !tray) create()
      if (!wanted && tray) destroy()
      refresh()
    },
    refresh,
    enabled: () => tray !== null,
    account,
    popoverContents: () => (popover && !popover.isDestroyed() ? popover.webContents : null),
    send(channel, ...args) {
      if (popover && !popover.isDestroyed()) popover.webContents.send(channel, ...args)
    },
    hidePopover,
    dispose: destroy
  }
}
