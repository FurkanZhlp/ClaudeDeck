import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  ProfileCategory,
  ProfileCategorySummary,
  ProfileDiffEntry,
  ProfileImportResult
} from '../../shared/types'
import { GUIDELINES_IMPORT_LINE, ensureGuidelinesImport, writeFileAtomic } from './guidelines'

/** Source entry (relative to the config dir) for each importable category. */
export const CATEGORY_ENTRIES: Record<ProfileCategory, string> = {
  instructions: 'CLAUDE.md',
  agents: 'agents',
  skills: 'skills',
  commands: 'commands',
  outputStyles: 'output-styles',
  settings: 'settings.json',
  plugins: 'plugins'
}

export const PROFILE_CATEGORIES = Object.keys(CATEGORY_ENTRIES) as ProfileCategory[]

export const isProfileCategory = (value: unknown): value is ProfileCategory =>
  typeof value === 'string' && Object.hasOwn(CATEGORY_ENTRIES, value)

const FINDER_JUNK = '.DS_Store'
const PLUGIN_INDEX_FILES = ['installed_plugins.json', 'known_marketplaces.json']
const STRIPPED_SETTINGS = ['apiKeyHelper']
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

type Json = Record<string, unknown>

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Top-level entries of a folder, ignoring dotfiles such as .DS_Store. */
function visibleEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith('.'))
}

export function summarizeSource(sourceDir: string): ProfileCategorySummary[] {
  return PROFILE_CATEGORIES.map((category) => {
    const stats = statOrNull(join(sourceDir, CATEGORY_ENTRIES[category]))
    let items = 0
    if (stats?.isDirectory())
      items = visibleEntries(join(sourceDir, CATEGORY_ENTRIES[category])).length
    else if (stats?.isFile()) items = 1
    return { category, available: items > 0, items }
  })
}

interface FileInfo {
  path: string
  size: number
  mtimeMs: number
  link: boolean
}

/** Files under `root` keyed by relative path; a missing root yields an empty map. */
function listFiles(root: string): Map<string, FileInfo> {
  const files = new Map<string, FileInfo>()
  const walk = (abs: string, rel: string): void => {
    let stats: Stats
    try {
      stats = rel === '' ? statSync(abs) : lstatSync(abs)
    } catch {
      return
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name !== FINDER_JUNK) walk(join(abs, name), rel ? join(rel, name) : name)
      }
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      files.set(rel, {
        path: abs,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        link: stats.isSymbolicLink()
      })
    }
  }
  walk(root, '')
  return files
}

function fingerprint(file: FileInfo): string {
  if (file.link) return `link:${readlinkSync(file.path)}`
  return createHash('sha256').update(readFileSync(file.path)).digest('hex')
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  if (a.link !== b.link) return false
  if (!a.link && a.size !== b.size) return false
  if (!a.link && a.mtimeMs === b.mtimeMs) return true
  return fingerprint(a) === fingerprint(b)
}

/** Per-category file counts that importing from `sourceDir` would add, change or remove. */
export function diffProfile(sourceDir: string, targetDir: string): ProfileDiffEntry[] {
  return PROFILE_CATEGORIES.map((category) => {
    const entry = CATEGORY_ENTRIES[category]
    const source = listFiles(join(sourceDir, entry))
    const target = listFiles(join(targetDir, entry))
    let added = 0
    let changed = 0
    let removed = 0
    for (const [rel, file] of source) {
      const existing = target.get(rel)
      if (!existing) added++
      else if (!sameFile(file, existing)) changed++
    }
    for (const rel of target.keys()) if (!source.has(rel)) removed++
    return { category, added, changed, removed }
  })
}

export type CopyRunner = (src: string, dest: string, dereference: boolean) => void

/** APFS clone through `cp -c`; fails on other volumes or file systems. */
export const cloneCopy: CopyRunner = (src, dest, dereference) => {
  execFileSync('/bin/cp', [dereference ? '-cRL' : '-cR', src, dest], { stdio: 'ignore' })
}

/**
 * Copies `src` to `dest` (which must not exist). The source is resolved first so a symlinked
 * folder is copied as a real folder; with `dereference` nested symlinks are copied as files too,
 * so later edits in the profile never write through a link into the source.
 */
export function copyEntry(
  src: string,
  dest: string,
  dereference: boolean,
  run: CopyRunner = cloneCopy
): void {
  const real = realpathSync(src)
  try {
    run(real, dest, dereference)
  } catch {
    cpSync(real, dest, { recursive: true, dereference, force: true })
  }
}

function readJson(file: string): Json {
  if (!existsSync(file)) return {}
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Imported keys win, account-only keys stay, secrets never travel and allow rules are unioned. */
export function mergeSettings(target: Json, source: Json): Json {
  const incoming: Json = { ...source }
  for (const key of STRIPPED_SETTINGS) delete incoming[key]
  if (isObject(incoming.env)) {
    const env = { ...incoming.env }
    for (const key of STRIPPED_ENV) delete env[key]
    incoming.env = env
  }
  const merged: Json = { ...target, ...incoming }
  const targetPerms = isObject(target.permissions) ? target.permissions : null
  const sourcePerms = isObject(incoming.permissions) ? incoming.permissions : null
  if (targetPerms && sourcePerms && Array.isArray(targetPerms.allow)) {
    const allow = Array.isArray(sourcePerms.allow) ? [...(sourcePerms.allow as unknown[])] : []
    for (const rule of targetPerms.allow as unknown[]) if (!allow.includes(rule)) allow.push(rule)
    merged.permissions = { ...sourcePerms, allow }
  }
  return merged
}

/** Deep-rewrites string values under `from` (plus a separator) to live under `to`. */
export function rewritePaths(value: unknown, from: string, to: string): unknown {
  const prefix = from.endsWith(sep) ? from : from + sep
  const target = to.endsWith(sep) ? to : to + sep
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith(prefix) ? target + v.slice(prefix.length) : v
    if (Array.isArray(v)) return v.map(walk)
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

function rewritePluginIndexes(pluginsDir: string, sourceDir: string, targetDir: string): void {
  for (const name of PLUGIN_INDEX_FILES) {
    const file = join(pluginsDir, name)
    if (!existsSync(file)) continue
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const before = JSON.stringify(json, null, 2)
    // Paths may be recorded through a symlinked or a resolved source root.
    for (const root of new Set([sourceDir, realpathSync(sourceDir)])) {
      json = rewritePaths(json, root, targetDir)
    }
    const after = JSON.stringify(json, null, 2)
    if (after !== before) writeFileAtomic(file, after + '\n')
  }
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/:/g, '-')
}

function freshDir(base: string): string {
  let dir = base
  for (let i = 1; existsSync(dir); i++) dir = `${base}-${i}`
  return dir
}

/**
 * Copies the chosen categories from `sourceDir` into `targetDir`. Existing target items are moved
 * to a timestamped backup folder first. `sourceDir` is only ever read.
 */
export function importProfile(
  sourceDir: string,
  targetDir: string,
  categories: ProfileCategory[],
  now: Date = new Date(),
  run: CopyRunner = cloneCopy
): ProfileImportResult {
  const source = resolve(sourceDir)
  const target = resolve(targetDir)
  if (source === target || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    throw new Error('source and target profiles overlap')
  }
  const chosen = PROFILE_CATEGORIES.filter((c) => categories.includes(c))
  const available = chosen.filter((c) => existsSync(join(source, CATEGORY_ENTRIES[c])))

  let backupDir: string | null = null
  const backup = (entry: string): void => {
    const from = join(target, entry)
    if (!existsSync(from) && !isLink(from)) return
    // A CLAUDE.md holding only the app's own import line has nothing of the user's to keep.
    if (
      entry === CATEGORY_ENTRIES.instructions &&
      !isLink(from) &&
      readFileSync(from, 'utf8').trim() === GUIDELINES_IMPORT_LINE
    ) {
      rmSync(from)
      return
    }
    backupDir ??= freshDir(join(target, 'claudedeck', 'backups', backupStamp(now)))
    mkdirSync(backupDir, { recursive: true })
    renameSync(from, join(backupDir, entry))
  }

  mkdirSync(target, { recursive: true })
  for (const category of available) {
    const entry = CATEGORY_ENTRIES[category]
    const src = join(source, entry)
    const dest = join(target, entry)
    if (category === 'settings') {
      // Parse both sides before moving anything so invalid JSON leaves the target untouched.
      const merged = mergeSettings(readJson(dest), readJson(src))
      backup(entry)
      writeFileAtomic(dest, JSON.stringify(merged, null, 2) + '\n')
      continue
    }
    backup(entry)
    copyEntry(src, dest, category !== 'plugins', run)
    if (category === 'plugins') rewritePluginIndexes(dest, source, target)
    if (category === 'instructions') ensureGuidelinesImport(target)
  }
  return { imported: available, backupDir }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
