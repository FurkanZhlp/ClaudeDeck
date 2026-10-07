import type { OsName } from './types'

const DRIVE_PATH = /^([a-zA-Z]):(?:[\\/]|$)/

/**
 * Absolute path in Claude Code permission rule syntax: a rule path starting with `//` is
 * absolute. Claude normalizes Windows paths to POSIX before matching (`C:\Users\a` becomes
 * `/c/Users/a`), so a rule must use that form or it silently never matches.
 *
 * - POSIX: `/Users/a` -> `//Users/a`
 * - Windows: `C:\Users\A B\x` -> `//c/Users/A B/x`
 *
 * Fails closed on Windows paths without a drive letter (UNC, relative): a deny rule that does
 * not match would leave the file readable.
 */
export function permissionRulePath(abs: string, os: OsName): string {
  if (os !== 'win32') return `/${abs}`
  const drive = DRIVE_PATH.exec(abs)
  if (!drive) throw new Error(`not a drive-letter path: ${abs}`)
  const rest = abs
    .slice(2)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  return `//${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}
