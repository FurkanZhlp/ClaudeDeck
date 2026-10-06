import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { Translate } from '../shared/translate'

export function buildMenu(t: Translate, opts: { dev: boolean; openSettings: () => void }): Menu {
  const view: MenuItemConstructorOptions[] = [{ role: 'togglefullscreen', label: t('menu.fullscreen') }]
  if (opts.dev) {
    view.unshift(
      { role: 'reload', label: t('menu.reload') },
      { role: 'toggleDevTools', label: t('menu.devTools') },
      { type: 'separator' }
    )
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: opts.openSettings },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    { label: t('menu.view'), submenu: view },
    { role: 'windowMenu', label: t('menu.window') }
  ]
  return Menu.buildFromTemplate(template)
}
