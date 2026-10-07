import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'
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

const isWindowsPath = (p: PlatformPath): boolean => p.sep === '\\'
const TRAILING_SEPARATORS = /[\\/]+$/

/**
 * Comparison key of a path: verbatim on POSIX; on Windows case-insensitive and with `/` read as
 * `\` (NTFS lookups ignore case, and both separators name the same file).
 */
export function pathKey(value: string, p: PlatformPath = nodePath): string {
  return isWindowsPath(p) ? value.replace(/\//g, '\\').toLowerCase() : value
}

/** Drops trailing separators on Windows, keeping a drive root (`C:\`) intact. */
function trimWindowsRoot(value: string, p: PlatformPath): string {
  if (!isWindowsPath(p)) return value
  const trimmed = value.replace(TRAILING_SEPARATORS, '')
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed || value
}

/** True when both name the same location (after `normalize`). */
export function samePath(a: string, b: string, p: PlatformPath = nodePath): boolean {
  const key = (v: string): string => pathKey(trimWindowsRoot(p.normalize(v), p), p)
  return key(a) === key(b)
}

/**
 * `value` without the leading `prefix`, or null when it does not start with it. The prefix is
 * compared by `pathKey`, so the rest keeps the original spelling.
 */
export function stripPathPrefix(
  value: string,
  prefix: string,
  p: PlatformPath = nodePath
): string | null {
  if (value.length < prefix.length) return null
  return pathKey(value.slice(0, prefix.length), p) === pathKey(prefix, p)
    ? value.slice(prefix.length)
    : null
}

/** True when `path` is `root` or lies below it. Both should already be resolved. */
export function isWithin(path: string, root: string, p: PlatformPath = nodePath): boolean {
  if (!isWindowsPath(p)) return path === root || path.startsWith(root + p.sep)
  const base = trimWindowsRoot(root, p)
  if (samePath(path, base, p)) return true
  const prefix = /[\\/]$/.test(base) ? base : `${base}\\`
  return stripPathPrefix(path, prefix, p) !== null
}

/** Path segments; on Windows both separators split. Empty segments are dropped. */
export function splitPath(value: string, p: PlatformPath = nodePath): string[] {
  return value.split(isWindowsPath(p) ? /[\\/]+/ : /\/+/).filter(Boolean)
}
