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
  /** Variables the command line assigns itself (`X=/; rm -rf $X`): their value is unknown. */
  shadowed?: ReadonlySet<string>
  /**
   * Variables the command line assigns a known value once, unconditionally (`X=~/.ssh; ...`):
   * they expand to it.
   */
  values?: ReadonlyMap<string, string>
  /** The tab's CLAUDE_CONFIG_DIR: `$CLAUDE_CONFIG_DIR` expands to it. */
  configDir?: string
}

/** Claude's config folder variable; in a tab it is the account's folder. */
export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR'

export const pathApi = (os: OsName): typeof nodePath.posix =>
  os === 'win32' ? nodePath.win32 : nodePath.posix

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/
/** Positional and special parameters (`$1`, `$@`, `$?`, ...): never known. */
const SPECIAL = /^([0-9]|[@*#?$!-])/

function lookup(name: string, e: PathEnv): string | undefined {
  const known = e.values?.get(name)
  if (known !== undefined) return known
  if (e.shadowed?.has(name)) return undefined
  const upper = name.toUpperCase()
  if (e.configDir && (name === CONFIG_DIR_VAR || (e.os === 'win32' && upper === CONFIG_DIR_VAR)))
    return e.configDir
  if (upper === 'HOME' || (e.os === 'win32' && upper === 'USERPROFILE')) return e.home
  if (upper === 'PWD') return e.cwd ?? undefined
  if (e.os !== 'win32') return e.env[name]
  const key = Object.keys(e.env).find((k) => k.toUpperCase() === upper)
  return key === undefined ? undefined : e.env[key]
}

/** Index after the `}` closing the `${` at `from` (braces nest). */
function bracedEnd(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * Value of `${...}` (the text between the braces). `emptyUnknown`: an unknown variable whose
 * expansion may be empty (`${X:-}`, `${X+...}`) counts as empty instead of unknown.
 */
function braced(inner: string, e: PathEnv, emptyUnknown: boolean, depth: number): string | null {
  if (inner.startsWith('env:')) return lookup(inner.slice(4), e) || null
  const name = NAME.exec(inner)?.[0]
  if (!name) return null
  const rest = inner.slice(name.length)
  const value = lookup(name, e)
  if (rest === '') return value || null
  const op = /^(:?)([-=?+])/.exec(rest)
  // Pattern removal, substitution, case changes, substrings: the result cannot be told.
  if (!op) return null
  const word = (): string | null => expand(rest.slice(op[0].length), e, emptyUnknown, depth + 1)
  const set = op[1] ? !!value : value !== undefined
  switch (op[2]) {
    case '-':
    case '=':
      if (set) return value as string
      if (value === undefined && !emptyUnknown) return null
      return word()
    case '?':
      return set ? (value as string) : null
    case '+':
      if (value === undefined) return emptyUnknown ? '' : null
      return set ? word() : ''
  }
  return null
}

/** Expands variables and `~`; null when anything in it cannot be told. */
function expand(text: string, e: PathEnv, emptyUnknown: boolean, depth = 0): string | null {
  if (depth > 4) return null
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '%' && e.os === 'win32') {
      const m = /^%([A-Za-z_][A-Za-z0-9_()]*)%/.exec(text.slice(i))
      if (m) {
        const value = lookup(m[1], e)
        if (!value) return null
        out += value
        i += m[0].length
        continue
      }
    }
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    const after = text.slice(i + 1)
    if (after.startsWith('{')) {
      const end = bracedEnd(text, i + 1)
      const value = braced(text.slice(i + 2, end - 1), e, emptyUnknown, depth)
      if (value === null) return null
      out += value
      i = end
      continue
    }
    const env = /^env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(after)
    const name = env ? env[1] : NAME.exec(after)?.[0]
    if (name) {
      const value = lookup(name, e)
      if (value === undefined || (value === '' && !emptyUnknown)) return null
      out += value
      i += 1 + (env ? env[0].length : name.length)
      continue
    }
    // `$(...)`, `$1`, `$@`, `$$`: unknown. A lone `$` stays as it is.
    if (after.startsWith('(') || SPECIAL.test(after)) return null
    out += ch
    i++
  }
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    if (e.shadowed?.has('HOME')) return null
    return e.home + out.slice(1)
  }
  // `~+` and `~-` are $PWD and $OLDPWD.
  if (/^~[+-]([\\/]|$)/.test(out)) return null
  if (/^~[A-Za-z0-9._-]+([\\/]|$)/.test(out)) {
    const p = pathApi(e.os)
    const user = /^~([A-Za-z0-9._-]+)/.exec(out) as RegExpExecArray
    return p.join(p.dirname(e.home), user[1]) + out.slice(user[0].length)
  }
  return out
}

/**
 * Expands `~`, `~user`, `$VAR`, `${VAR}`, `${VAR:-default}`, `%VAR%` and `$env:VAR`. Null when a
 * variable is not known (its value, and so the path, cannot be told), for positional and
 * special parameters, and for `${...}` forms whose result depends on the value (`${X%/}`).
 */
export function expandPath(text: string, e: PathEnv): string | null {
  return expand(text, e, false)
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
  return resolveExpanded(expandPath(text, e), e)
}

/**
 * The path when every expansion that may be empty is empty (`"${DIR:-}/"`, `"$EMPTY/"` give
 * `/`); null when it still cannot be told.
 */
export function resolveCollapsed(text: string, e: PathEnv): string | null {
  return resolveExpanded(expand(text, e, true), e)
}

function resolveExpanded(expanded: string | null, e: PathEnv): string | null {
  if (expanded === null || expanded === '') return null
  const p = pathApi(e.os)
  const path = e.os === 'win32' ? windowsForm(expanded) : expanded
  if (p.isAbsolute(path) && !(e.os === 'win32' && /^\\(?!\\)/.test(path))) {
    return p.resolve(path)
  }
  if (e.cwd === null) return null
  return p.resolve(e.cwd, path)
}

/** Recent canonical forms: the protected folders are compared with every target. */
const CANON_CACHE = new Map<string, string>()
const MAX_CANON_CACHE = 4096

/** Comparable form: case folded on Windows and macOS, `/private/etc` as `/etc` on macOS. */
export function canon(path: string, os: OsName): string {
  const key = `${os}\0${path}`
  const hit = CANON_CACHE.get(key)
  if (hit !== undefined) return hit
  const out = canonUncached(path, os)
  if (CANON_CACHE.size >= MAX_CANON_CACHE) CANON_CACHE.clear()
  CANON_CACHE.set(key, out)
  return out
}

function canonUncached(path: string, os: OsName): string {
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
