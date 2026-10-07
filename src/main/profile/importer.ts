import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import * as nodePath from 'node:path'
import { dirname, isAbsolute, join, relative, resolve, type PlatformPath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  ProfileCategory,
  ProfileCategorySummary,
  ProfileDiffEntry,
  ProfileImportResult
} from '../../shared/types'
import { platform } from '../platform'
import {
  cloneCopy,
  nodeCopy,
  renameWithRetryAsync,
  rmWithRetryAsync,
  safeSymlink
} from '../platform/fs'
import { isWithin, pathKey, samePath, splitPath, stripPathPrefix } from '../platform/paths'
import type { CopyRunner, OsName } from '../platform/types'
import { GUIDELINES_IMPORT_LINE, withGuidelinesImport } from './guidelines'

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

/** File manager metadata (Finder, Explorer); never counted or compared. Lower case. */
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const isJunk = (name: string): boolean => JUNK_FILES.has(name.toLowerCase())
const TMP_SUFFIX = '.claudedeck-tmp'
const SETTINGS_MODE = 0o600
const PLUGIN_INDEX_FILES = ['installed_plugins.json', 'known_marketplaces.json']
const STRIPPED_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper'
]
const SECRET_ENV = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i
const UNION_PERMISSIONS = ['allow', 'deny', 'ask', 'additionalDirectories']
/** Top-level names a CLAUDE.md `@import` may never pull into the profile. */
const DENIED_IMPORT_ROOTS = new Set([
  'settings.json',
  'settings.local.json',
  'projects',
  'sessions',
  'plugins',
  'history.jsonl'
])
const GUIDELINES_FILE = GUIDELINES_IMPORT_LINE.slice(1)

/** Plugins keep their symlinks; everything else is copied (and compared) through them. */
const followsLinks = (category: ProfileCategory): boolean => category !== 'plugins'

type Json = Record<string, unknown>

/** Thrown when one category could not be imported; the target keeps its previous content. */
export class ProfileImportError extends Error {
  constructor(
    readonly category: ProfileCategory,
    cause: unknown
  ) {
    super(`importing ${category} failed: ${cause instanceof Error ? cause.message : cause}`, {
      cause
    })
    this.name = 'ProfileImportError'
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

async function statAsync(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function lstatAsync(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

// Windows: case-insensitive, either separator.
const within = (path: string, root: string): boolean => isWithin(path, root)

const rename = renameWithRetryAsync(platform.os)
const rm = rmWithRetryAsync(platform.os)
const symlink = safeSymlink(platform.os)

/** Top-level entries of a folder, ignoring dotfiles such as .DS_Store and Explorer files. */
function visibleEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith('.') && !isJunk(name))
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

/**
 * Where symlinks of a copied entry must point. Links inside the entry stay relative, links into
 * the source profile are moved into the target profile, anything else keeps its destination.
 */
interface Relocation {
  /** Resolved source entry, where the links physically live. */
  realEntry: string
  roots: Array<[from: string, to: string]>
  /** Source profile roots (resolved and as given) mapped to the target profile. */
  profileRoots: Array<[from: string, to: string]>
  /** Folders a link may lead into when it has to become a copy (Windows without symlinks). */
  linkRoots: string[]
}

async function relocationFor(source: string, target: string, entry: string): Promise<Relocation> {
  const srcEntry = join(source, entry)
  const destEntry = join(target, entry)
  const realEntry = await realpath(srcEntry)
  const profileRoots: Array<[string, string]> = [
    [await realpath(source), target],
    [source, target]
  ]
  return {
    realEntry,
    roots: [[realEntry, destEntry], [srcEntry, destEntry], ...profileRoots],
    profileRoots,
    linkRoots: [source, target]
  }
}

/** New value for a link found at `rel` (relative to the entry) with the value `value`. */
export function relocateLink(value: string, rel: string, relocation: Relocation): string {
  const resolved = resolve(relocation.realEntry, dirname(rel), value)
  if (!isAbsolute(value) && within(resolved, relocation.realEntry)) return value
  for (const [from, to] of relocation.roots) {
    if (within(resolved, from)) return to + resolved.slice(from.length)
  }
  return resolved
}

/** Rewrites every symlink under `dir` (a copy of the relocation's entry) in place. */
async function relocateLinks(dir: string, relocation: Relocation): Promise<void> {
  const walk = async (abs: string, rel: string): Promise<void> => {
    const stats = await lstatAsync(abs)
    if (!stats) return
    if (stats.isSymbolicLink()) {
      const value = await readlink(abs)
      const next = relocateLink(value, rel, relocation)
      if (next !== value) {
        await unlink(abs)
        await symlink(next, abs, relocation.linkRoots)
      }
    } else if (stats.isDirectory()) {
      for (const name of await readdir(abs)) await walk(join(abs, name), join(rel, name))
    }
  }
  await walk(dir, '')
}

interface FileInfo {
  path: string
  size: number
  mtimeMs: number
  link: boolean
}

/**
 * Files under `root` keyed by relative path; a missing root yields an empty map. With `follow`
 * symlinks are walked like the copy dereferences them, otherwise they are listed as links.
 */
async function listFiles(root: string, follow: boolean): Promise<Map<string, FileInfo>> {
  const files = new Map<string, FileInfo>()
  const walk = async (abs: string, rel: string, ancestors: string[]): Promise<void> => {
    const stats = rel === '' || follow ? await statAsync(abs) : await lstatAsync(abs)
    if (!stats) return
    if (stats.isDirectory()) {
      let chain = ancestors
      if (follow) {
        // A link back to an ancestor would recurse forever.
        const real = await realpath(abs)
        if (ancestors.includes(real)) return
        chain = [...ancestors, real]
      }
      for (const name of await readdir(abs)) {
        if (!isJunk(name)) await walk(join(abs, name), rel ? join(rel, name) : name, chain)
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
  await walk(root, '', [])
  return files
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Copies keep timestamps, but a fallback copy may only keep whole milliseconds. */
const sameTime = (a: FileInfo, b: FileInfo): boolean => Math.abs(a.mtimeMs - b.mtimeMs) < 1

async function sameContent(a: FileInfo, b: FileInfo): Promise<boolean> {
  if (a.size !== b.size) return false
  if (sameTime(a, b)) return true
  return (await hashFile(a.path)) === (await hashFile(b.path))
}

/** Plugin trees can be huge: links are compared by destination, files by size and mtime only. */
async function samePluginFile(
  a: FileInfo,
  b: FileInfo,
  rel: string,
  relocation: Relocation
): Promise<boolean> {
  if (a.link !== b.link) return false
  if (a.link)
    return relocateLink(await readlink(a.path), rel, relocation) === (await readlink(b.path))
  if (PLUGIN_INDEX_FILES.includes(rel)) {
    const expected = await rewrittenIndex(a.path, relocation.profileRoots)
    return expected === (await readFile(b.path, 'utf8'))
  }
  return a.size === b.size && sameTime(a, b)
}

async function readText(file: string): Promise<string | null> {
  const stats = await statAsync(file)
  return stats?.isFile() ? readFile(file, 'utf8') : null
}

/** A CLAUDE.md holding only the app's own import line has nothing of the user's in it. */
const isGuidelinesOnly = (text: string): boolean => text.trim() === GUIDELINES_IMPORT_LINE

const counts = (
  category: ProfileCategory,
  added = 0,
  changed = 0,
  removed = 0
): ProfileDiffEntry => ({ category, added, changed, removed })

async function diffCategory(
  category: ProfileCategory,
  source: string,
  target: string
): Promise<ProfileDiffEntry> {
  const entry = CATEGORY_ENTRIES[category]
  const src = join(source, entry)
  const dest = join(target, entry)
  // Importing an absent category changes nothing.
  if (!(await statAsync(src))) return counts(category)

  if (category === 'instructions') {
    const incoming = await readText(src)
    let current = await readText(dest)
    if (current !== null && isGuidelinesOnly(current)) current = null
    if (incoming === null) return counts(category)
    if (current === null) return counts(category, 1)
    return counts(category, 0, withGuidelinesImport(incoming) === current ? 0 : 1)
  }

  if (category === 'settings') {
    if (!(await statAsync(dest))) return counts(category, 1)
    try {
      const current = await readJson(dest)
      const unchanged = isDeepStrictEqual(mergeSettings(current, await readJson(src)), current)
      return counts(category, 0, unchanged ? 0 : 1)
    } catch {
      return counts(category, 0, 1)
    }
  }

  const follow = followsLinks(category)
  const incoming = await listFiles(src, follow)
  const current = await listFiles(dest, follow)
  const relocation = follow ? null : await relocationFor(source, target, entry)
  let added = 0
  let changed = 0
  let removed = 0
  for (const [rel, file] of incoming) {
    const existing = current.get(rel)
    if (!existing) added++
    else if (
      !(relocation
        ? await samePluginFile(file, existing, rel, relocation)
        : !file.link && !existing.link && (await sameContent(file, existing)))
    )
      changed++
  }
  for (const rel of current.keys()) if (!incoming.has(rel)) removed++
  return counts(category, added, changed, removed)
}

/** Per-category file counts that importing from `sourceDir` would add, change or remove. */
export async function diffProfile(
  sourceDir: string,
  targetDir: string
): Promise<ProfileDiffEntry[]> {
  const source = resolve(sourceDir)
  const target = resolve(targetDir)
  const result: ProfileDiffEntry[] = []
  for (const category of PROFILE_CATEGORIES) {
    result.push(await diffCategory(category, source, target))
  }
  return result
}

export { cloneCopy, type CopyRunner }

/**
 * Copies `src` to `dest` (which must not exist), keeping timestamps. The source is resolved first
 * so a symlinked folder is copied as a real folder; with `dereference` nested symlinks are copied
 * as files too, so later edits in the profile never write through a link into the source.
 * Without it links are copied verbatim (relative links stay relative). `roots`: see CopyRunner.
 * A failed clone falls back to a plain Node copy.
 */
export async function copyEntry(
  src: string,
  dest: string,
  dereference: boolean,
  run: CopyRunner = platform.copyRunner,
  roots: readonly string[] = []
): Promise<void> {
  const real = await realpath(src)
  try {
    await run(real, dest, dereference, roots)
  } catch (error) {
    // The plain copy is already the fallback; running it again would repeat the same failure.
    if (run === nodeCopy) throw error
    await rm(dest, { recursive: true, force: true })
    await nodeCopy(real, dest, dereference, roots)
  }
}

async function readJson(file: string): Promise<Json> {
  const text = await readText(file)
  if (text === null) return {}
  const value: unknown = JSON.parse(text)
  return isObject(value) ? value : {}
}

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function withoutSecrets(source: Json): Json {
  const incoming: Json = { ...source }
  for (const key of STRIPPED_SETTINGS) delete incoming[key]
  if (isObject(incoming.env)) {
    incoming.env = Object.fromEntries(
      Object.entries(incoming.env).filter(([key]) => !SECRET_ENV.test(key))
    )
  }
  return incoming
}

function mergePermissions(target: Json, source: Json): Json {
  const merged: Json = { ...target, ...source }
  for (const key of UNION_PERMISSIONS) {
    const lists = [source[key], target[key]].filter(Array.isArray) as unknown[][]
    if (lists.length) merged[key] = [...new Set(lists.flat())]
  }
  // The account's own default mode is a safety choice; only fill it when missing.
  if (target.defaultMode !== undefined) merged.defaultMode = target.defaultMode
  return merged
}

/**
 * Imported keys win and account-only keys stay. Secrets and credential helpers never travel,
 * env maps are merged, permission lists are unioned and the account's default mode is kept.
 */
export function mergeSettings(target: Json, source: Json): Json {
  const incoming = withoutSecrets(source)
  const merged: Json = { ...target, ...incoming }
  if (isObject(target.env) && isObject(incoming.env)) {
    merged.env = { ...target.env, ...incoming.env }
  }
  const targetPerms = isObject(target.permissions) ? target.permissions : null
  const sourcePerms = isObject(incoming.permissions) ? incoming.permissions : null
  if (targetPerms && sourcePerms) merged.permissions = mergePermissions(targetPerms, sourcePerms)
  return merged
}

/**
 * Deep-rewrites string values under `from` (plus a separator) to live under `to`. With
 * `path.win32` the prefix matches case-insensitively and with either separator.
 */
export function rewritePaths(
  value: unknown,
  from: string,
  to: string,
  p: PlatformPath = nodePath
): unknown {
  const endsWithSep = (v: string): boolean =>
    v.endsWith(p.sep) || (p.sep === '\\' && v.endsWith('/'))
  const prefix = endsWithSep(from) ? from : from + p.sep
  const target = endsWithSep(to) ? to : to + p.sep
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const rest = stripPathPrefix(v, prefix, p)
      return rest === null ? v : target + rest
    }
    if (Array.isArray(v)) return v.map(walk)
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

/** Text of a plugin index file once its paths point into the target profile. */
async function rewrittenIndex(file: string, roots: Array<[string, string]>): Promise<string> {
  const raw = await readFile(file, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return raw
  }
  const before = JSON.stringify(json, null, 2)
  // Paths may be recorded through a symlinked or a resolved source root.
  for (const [from, to] of roots) json = rewritePaths(json, from, to)
  const after = JSON.stringify(json, null, 2)
  return after === before ? raw : after + '\n'
}

async function rewritePluginIndexes(
  pluginsDir: string,
  roots: Array<[string, string]>
): Promise<void> {
  for (const name of PLUGIN_INDEX_FILES) {
    const file = join(pluginsDir, name)
    if (!(await statAsync(file))?.isFile()) continue
    const raw = await readFile(file, 'utf8')
    const next = await rewrittenIndex(file, roots)
    if (next !== raw) await writeFile(file, next, 'utf8')
  }
}

/**
 * Whether an `@import` reference may be followed at all. Never absolute or home-relative. On
 * Windows a segment must not hold `:` (drive or alternate data stream) or `~` (8.3 short name),
 * nor end with a dot or space (trimmed by Win32): each would let a name pass the checks below
 * while opening another file.
 */
export function importRefAllowed(ref: string, os: OsName = platform.os): boolean {
  const p = os === 'win32' ? nodePath.win32 : nodePath.posix
  if (!ref || p.isAbsolute(ref) || ref.startsWith('~')) return false
  if (os !== 'win32') return true
  return splitPath(ref, p).every(
    (segment) =>
      segment === '.' ||
      segment === '..' ||
      !(/[:~]/.test(segment) || segment.endsWith('.') || segment.endsWith(' '))
  )
}

/** A profile-relative path an import may not copy (private, app-managed or a category entry). */
function deniedImport(rel: string): boolean {
  const top = splitPath(rel)[0] ?? ''
  // Windows file names ignore case: `@Settings.json` is settings.json there.
  return (
    top.startsWith('.') ||
    DENIED_IMPORT_ROOTS.has(pathKey(top)) ||
    samePath(rel, CATEGORY_ENTRIES.instructions) ||
    samePath(rel, GUIDELINES_FILE) ||
    within(rel, join('claudedeck', 'backups'))
  )
}

/**
 * Relative files the source CLAUDE.md pulls in with `@path` lines, so they can travel with it.
 * Only existing files inside the source profile are returned, never app-managed or private ones.
 * Both the written path and the resolved one (links followed) must pass, and the resolved file
 * must stay inside the resolved source profile.
 */
async function instructionImports(source: string, text: string): Promise<string[]> {
  const realSource = await realpath(source)
  const found = new Set<string>()
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) fenced = !fenced
    if (fenced || !trimmed.startsWith('@')) continue
    const ref = trimmed.slice(1).split(/\s+/, 1)[0] ?? ''
    if (!importRefAllowed(ref)) continue
    const abs = resolve(source, ref)
    if (!within(abs, source) || samePath(abs, source)) continue
    const rel = relative(source, abs)
    if (deniedImport(rel)) continue
    let real: string
    try {
      real = await realpath(abs)
    } catch {
      continue
    }
    if (!within(real, realSource) || samePath(real, realSource)) continue
    if (deniedImport(relative(realSource, real))) continue
    if ((await statAsync(real))?.isFile()) found.add(rel)
  }
  return [...found]
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/:/g, '-')
}

async function freshDir(base: string): Promise<string> {
  let dir = base
  for (let i = 1; await lstatAsync(dir); i++) dir = `${base}-${i}`
  return dir
}

/**
 * Copies the chosen categories from `sourceDir` into `targetDir`. Each item is built next to its
 * destination first; only once that succeeded is the existing item moved to a timestamped backup
 * folder and the new one renamed into place, so a failure never leaves an item missing.
 * `sourceDir` is only ever read.
 */
export async function importProfile(
  sourceDir: string,
  targetDir: string,
  categories: ProfileCategory[],
  now: Date = new Date(),
  run: CopyRunner = platform.copyRunner
): Promise<ProfileImportResult> {
  const source = resolve(sourceDir)
  const target = resolve(targetDir)
  if (samePath(source, target) || within(target, source) || within(source, target)) {
    throw new Error('source and target profiles overlap')
  }
  const chosen = PROFILE_CATEGORIES.filter((c) => categories.includes(c))
  const available: ProfileCategory[] = []
  for (const category of chosen) {
    if (await statAsync(join(source, CATEGORY_ENTRIES[category]))) available.push(category)
  }

  let backupDir: string | null = null
  /** Moves the current item away; returns where it went, or null when nothing was there. */
  const backup = async (entry: string): Promise<string | null> => {
    const from = join(target, entry)
    const stats = await lstatAsync(from)
    if (!stats) return null
    // Files are replaced atomically by the rename; the app's own import line is not worth keeping.
    if (
      entry === CATEGORY_ENTRIES.instructions &&
      stats.isFile() &&
      isGuidelinesOnly(await readFile(from, 'utf8'))
    ) {
      return null
    }
    backupDir ??= await freshDir(join(target, 'claudedeck', 'backups', backupStamp(now)))
    const to = join(backupDir, entry)
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    return to
  }

  const replaceItem = async (
    entry: string,
    produce: (tmp: string) => Promise<void>
  ): Promise<void> => {
    const dest = join(target, entry)
    const tmp = dest + TMP_SUFFIX
    await mkdir(dirname(dest), { recursive: true })
    await rm(tmp, { recursive: true, force: true })
    try {
      await produce(tmp)
    } catch (error) {
      await rm(tmp, { recursive: true, force: true })
      throw error
    }
    const moved = await backup(entry)
    try {
      await rename(tmp, dest)
    } catch (error) {
      if (moved) await rename(moved, dest).catch(() => undefined)
      await rm(tmp, { recursive: true, force: true })
      throw error
    }
  }

  await mkdir(target, { recursive: true })
  for (const category of available) {
    const entry = CATEGORY_ENTRIES[category]
    const src = join(source, entry)
    try {
      if (category === 'settings') {
        // Parse both sides before touching anything so invalid JSON leaves the target untouched.
        const merged = mergeSettings(await readJson(join(target, entry)), await readJson(src))
        await replaceItem(entry, (tmp) =>
          writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', {
            encoding: 'utf8',
            mode: SETTINGS_MODE
          })
        )
      } else if (category === 'instructions') {
        const text = await readFile(src, 'utf8')
        for (const rel of await instructionImports(source, text)) {
          await replaceItem(rel, (tmp) => copyEntry(join(source, rel), tmp, true, run))
        }
        await replaceItem(entry, (tmp) => writeFile(tmp, withGuidelinesImport(text), 'utf8'))
      } else {
        const follow = followsLinks(category)
        const relocation = follow ? null : await relocationFor(source, target, entry)
        await replaceItem(entry, async (tmp) => {
          await copyEntry(src, tmp, follow, run, [source])
          if (!relocation) return
          await relocateLinks(tmp, relocation)
          if (category === 'plugins') await rewritePluginIndexes(tmp, relocation.profileRoots)
        })
      }
    } catch (error) {
      throw new ProfileImportError(category, error)
    }
  }
  return { imported: available, backupDir }
}
