import { IPC } from '../../shared/ipc'

/**
 * Invoke channels the menu bar popover may call: exactly what its renderer uses (state, usage
 * readings, plans, statistics, a forced poll, and its own app actions). Everything else, such as
 * terminals, accounts, projects, notes and profiles, answers the main window only.
 */
export const TRAY_CHANNELS: ReadonlySet<string> = new Set([
  IPC.stateGet,
  IPC.usageList,
  IPC.usagePlans,
  IPC.usageStats,
  IPC.usagePollNow,
  IPC.appTrayAccount,
  IPC.appOpenMain,
  IPC.appQuit,
  // Sent, not invoked: menuBar listens on the popover's own webContents, so only it can resize.
  IPC.appTrayResize
])
