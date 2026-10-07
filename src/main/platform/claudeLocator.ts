import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { DomainError } from '../../shared/errors'
import { getEnv, withFallbackPath, WIN_PATH_KEY } from '../env/shellEnv'
import {
  CLAUDE_BIN,
  WHICH_PATH,
  WIN_DEFAULT_PATHEXT,
  WIN_DIRECT_EXTS,
  WIN_NPM_CLAUDE_EXE,
  WIN_SHIM_EXTS
} from './constants'
import { isWithin } from './paths'
import type { ClaudeLocator, Env, OsName } from './types'

/** A drive path (`C:\\...`) or a UNC share (`\\\\server\\share...`); nothing relative. */
const SEARCHABLE_DIR = /^(?:[a-zA-Z]:\\|\\\\[^\\/]+\\[^\\/]+)/
/** The only file an npm shim may lead to. */
const NPM_TARGET_NAME = `${CLAUDE_BIN}.exe`

/** File system reads the Windows lookup needs; injected in tests. */
export interface LocatorFs {
  isFile(path: string): boolean
  /** File contents, or null when it cannot be read. */
  readText(path: string): string | null
}

export const nodeLocatorFs: LocatorFs = {
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
}

/** `Path` entries plus the install dirs a GUI-started app may lack, in search order. */
export function windowsSearchDirs(env: Env): string[] {
  const home = getEnv(env, 'USERPROFILE', 'win32') || homedir()
  const path = withFallbackPath(env, home, 'win32')[WIN_PATH_KEY] ?? ''
  return path
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => SEARCHABLE_DIR.test(dir))
}

/** First `dir\name` that exists, over the search dirs. */
export function findOnWindowsPath(env: Env, name: string, fs: LocatorFs): string | null {
  for (const dir of windowsSearchDirs(env)) {
    const file = win32.join(dir, name)
    if (fs.isFile(file)) return file
  }
  return null
}

function pathExts(env: Env): string[] {
  return (getEnv(env, 'PATHEXT', 'win32') || WIN_DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
}

// npm's cmd-shim quotes its target relative to the shim dir: "%dp0%\node_modules\...\x.exe"
// (older shims use "%~dp0\...").
const SHIM_TARGET = /"%~?dp0%?\\?([^"]+)"/gi

/**
 * The native binary behind an npm `claude.cmd` shim. The package's bin is `bin/claude.exe`
 * today; an older JavaScript entry point counts only if the package also ships that binary.
 * A target must be a `claude.exe` inside the shim's own folder tree.
 */
export function shimTarget(shim: string, fs: LocatorFs): string | null {
  const text = fs.readText(shim)
  if (text === null) return null
  const dir = win32.dirname(shim)
  const targets = [...text.matchAll(SHIM_TARGET)]
    .map((match) => win32.join(dir, match[1]))
    .filter(
      (file) => win32.basename(file).toLowerCase() === NPM_TARGET_NAME && isWithin(file, dir, win32)
    )
  for (const file of targets.reverse()) {
    if (fs.isFile(file)) return file
  }
  const packaged = win32.join(dir, ...WIN_NPM_CLAUDE_EXE)
  return fs.isFile(packaged) ? packaged : null
}

/**
 * Absolute path of a `claude` that `spawn` can start without a shell: a `claude.exe` or
 * `claude.com` anywhere on the search path first (PATHEXT order), then the target of an npm
 * `claude.cmd` / `claude.bat` shim. Null when there is none.
 */
export function locateClaudeWindows(env: Env, fs: LocatorFs = nodeLocatorFs): string | null {
  const dirs = windowsSearchDirs(env)
  const exts = pathExts(env)
  for (const ext of exts.filter((e) => WIN_DIRECT_EXTS.includes(e))) {
    for (const dir of dirs) {
      const file = win32.join(dir, `${CLAUDE_BIN}${ext}`)
      if (fs.isFile(file)) return file
    }
  }
  for (const ext of exts.filter((e) => WIN_SHIM_EXTS.includes(e))) {
    for (const dir of dirs) {
      const shim = win32.join(dir, `${CLAUDE_BIN}${ext}`)
      if (!fs.isFile(shim)) continue
      const target = shimTarget(shim, fs)
      if (target) return target
    }
  }
  return null
}

const posixLocator: ClaudeLocator = {
  available: (env) =>
    new Promise((done) => execFile(WHICH_PATH, [CLAUDE_BIN], { env }, (error) => done(!error))),
  // execFile looks the name up on the env's PATH.
  file: () => Promise.resolve(CLAUDE_BIN)
}

export function windowsLocator(fs: LocatorFs = nodeLocatorFs): ClaudeLocator {
  return {
    available: (env) => Promise.resolve(locateClaudeWindows(env, fs) !== null),
    file: (env) => {
      const file = locateClaudeWindows(env, fs)
      return file ? Promise.resolve(file) : Promise.reject(new DomainError('CLAUDE_NOT_FOUND'))
    }
  }
}

export function claudeLocator(os: OsName, fs: LocatorFs = nodeLocatorFs): ClaudeLocator {
  return os === 'win32' ? windowsLocator(fs) : posixLocator
}
