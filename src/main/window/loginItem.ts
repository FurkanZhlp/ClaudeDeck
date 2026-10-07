import type { Settings } from 'electron'

/** Marks a launch started by the Windows login item (Windows has no `wasOpenedAtLogin`). */
export const LAUNCHED_AT_LOGIN_ARG = '--launched-at-login'

/** Login item settings per platform; Windows passes a marker argument to detect the launch. */
export function loginItemSettings(platform: NodeJS.Platform, openAtLogin: boolean): Settings {
  return platform === 'win32' ? { openAtLogin, args: [LAUNCHED_AT_LOGIN_ARG] } : { openAtLogin }
}

/**
 * Whether this process was started by the login item. macOS reports it through
 * `getLoginItemSettings().wasOpenedAtLogin`; Windows through the marker argument.
 */
export function wasOpenedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  macLoginItem: () => { wasOpenedAtLogin?: boolean }
): boolean {
  if (platform === 'win32') return argv.includes(LAUNCHED_AT_LOGIN_ARG)
  if (platform !== 'darwin') return false
  try {
    return macLoginItem().wasOpenedAtLogin === true
  } catch {
    return false
  }
}
