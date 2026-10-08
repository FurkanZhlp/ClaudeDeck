import * as nodePath from 'node:path'
import type { OsName } from '../platform/types'

/**
 * Path handling of the guard. Nothing touches the file system: paths are expanded and resolved
 * as text (symlinks are not followed), and compared case-insensitively where the default file
 * system is (Windows, macOS).
 */

export interface PathEnv {
  /** Folder relative paths resolve against; null when it is unknown (`cd "$X" && ...`). */
  cwd: string | null
  home: string
  os: OsName
  env: Record<string, string | undefined>
}

const VARIABLE =
  /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_()]*)%/g

export const pathApi = (os: OsName): typeof nodePath.posix =>
  os === 'win32' ? nodePath.win32 : nodePath.posix

function lookup(name: string, e: PathEnv): string | undefined {
  const upper = name.toUpperCase()
  if (upper === 'HOME' || (e.os === 'win32' && upper === 'USERPROFILE')) return e.home
  if (upper === 'PWD') return e.cwd ?? undefined
  if (e.os !== 'win32') return e.env[name]
  const key = Object.keys(e.env).find((k) => k.toUpperCase() === upper)
  return key === undefined ? undefined : e.env[key]
}

/**
 * Expands `~`, `~user`, `$VAR`, `${VAR}`, `%VAR%` and `$env:VAR`. Null when a variable is not
 * known (its value, and so the path, cannot be told).
 */
export function expandPath(text: string, e: PathEnv): string | null {
  let unknown = false
  let out = text.replace(VARIABLE, (_m, a, b, c, d, f) => {
    const value = lookup((a ?? b ?? c ?? d ?? f) as string, e)
    if (value === undefined || value === '') unknown = true
    return value ?? ''
  })
  if (unknown) return null
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = e.home + out.slice(1)
  } else if (/^~[A-Za-z0-9._-]+([\\/]|$)/.test(out)) {
    const p = pathApi(e.os)
    const user = /^~([A-Za-z0-9._-]+)/.exec(out) as RegExpExecArray
    out = p.join(p.dirname(e.home), user[1]) + out.slice(user[0].length)
  }
  return out
}

/** Git Bash (`/c/Users`), Cygwin (`/cygdrive/c`) and `C:/` forms as Windows paths. */
function windowsForm(text: string): string {
  let out = text.replace(/^\\\\\?\\/, '')
  const mount = /^\/(?:cygdrive\/)?([A-Za-z])(\/|$)/.exec(out)
  if (mount) out = `${mount[1]}:\\${out.slice(mount[0].length)}`
  if (/^[A-Za-z]:$/.test(out)) out += '\\'
  return out.replace(/\//g, '\\')
}

/** Absolute, normalised path; null when it cannot be told (unknown variable or folder). */
export function resolvePath(text: string, e: PathEnv): string | null {
  const expanded = expandPath(text, e)
  if (expanded === null || expanded === '') return null
  const p = pathApi(e.os)
  const path = e.os === 'win32' ? windowsForm(expanded) : expanded
  if (p.isAbsolute(path) && !(e.os === 'win32' && /^\\(?!\\)/.test(path))) {
    return p.resolve(path)
  }
  if (e.cwd === null) return null
  return p.resolve(e.cwd, path)
}

/** Comparable form: case folded on Windows and macOS, `/private/etc` as `/etc` on macOS. */
export function canon(path: string, os: OsName): string {
  const p = pathApi(os)
  let out = p.normalize(path)
  if (out.length > 1 && /[\\/]$/.test(out) && !/^[A-Za-z]:\\$/.test(out)) out = out.slice(0, -1)
  if (os === 'darwin') out = out.replace(/^\/private\/(etc|var|tmp)(?=\/|$)/i, '/$1')
  return os === 'win32' || os === 'darwin' ? out.toLowerCase() : out
}

/** `path` is `dir` or inside it. Both absolute. */
export function within(path: string, dir: string, os: OsName): boolean {
  const a = canon(path, os)
  const b = canon(dir, os)
  if (a === b) return true
  const sep = os === 'win32' ? '\\' : '/'
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** Path segments of `path` below `dir` (canonical case), or null when it is not inside. */
export function relativeParts(path: string, dir: string, os: OsName): string[] | null {
  if (!within(path, dir, os)) return null
  const a = canon(path, os)
  const b = canon(dir, os)
  if (a === b) return []
  return a.slice(b.length).split(/[\\/]/).filter(Boolean)
}

/** Segments of an absolute path (canonical case), drive or root first: `['c:', 'users']`. */
export function segments(path: string, os: OsName): string[] {
  const c = canon(path, os)
  if (os === 'win32') return c.split('\\').filter(Boolean)
  return c.split('/').filter(Boolean)
}

/** The drive root or `/`. */
export function isRoot(path: string, os: OsName): boolean {
  return segments(path, os).length === (os === 'win32' ? 1 : 0)
}

const GLOB = /[*?[]/

/**
 * Splits a delete target at its first glob segment: the folder before it and whether the glob
 * selects everything in that folder (`*`, `.*`, `*.*`, `{*,.*}`).
 */
export function globBase(text: string): { base: string; all: boolean } | null {
  if (!GLOB.test(text)) return null
  const parts = text.split(/(?<=[\\/])/)
  let base = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].replace(/[\\/]$/, '')
    if (GLOB.test(part)) {
      const rest = parts.slice(i + 1).join('')
      const all = /^(\*|\.\*|\*\.\*|\{\*,\.\*\}|\{\.\*,\*\})$/.test(part) && rest === ''
      return { base: base || '.', all }
    }
    base += parts[i]
  }
  return null
}
