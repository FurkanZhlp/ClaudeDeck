import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithRetry, writeFileAtomicSync } from '../platform/fs'
import { writeFileAtomic } from './guidelines'

/** Mode for an account's settings.json and other private files ClaudeDeck writes there. */
export const SETTINGS_MODE = 0o600

// Windows briefly locks files (antivirus, indexer); retried there, a plain rename elsewhere.
const renameFile = renameWithRetry(process.platform)

export type Json = Record<string, unknown>

export const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export const settingsPath = (configDir: string): string => join(configDir, 'settings.json')

/** Text of the file, or null when it does not exist. */
export function readTextOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Settings text parsed: {} when missing or empty, null when it is not a JSON object. */
export function parseSettings(text: string | null): Json | null {
  if (text === null || text.trim() === '') return {}
  try {
    const json: unknown = JSON.parse(text)
    return isObject(json) ? json : null
  } catch {
    return null
  }
}

/** Parsed settings.json; {} when missing or empty, null when it is not a JSON object. */
export function readSettings(file: string): Json | null {
  return parseSettings(readTextOrNull(file))
}

/**
 * Where a write to `file` goes: the target of a symlinked settings.json (dotfile setups link
 * it into a repository), so the atomic rename replaces the target and keeps the link.
 */
export function writeTarget(file: string): string {
  try {
    if (lstatSync(file).isSymbolicLink()) return realpathSync(file)
  } catch {
    // Missing file or dangling link: written in place.
  }
  return file
}

export interface WriteSettingsOptions {
  /**
   * The text the new settings were derived from (null: no file). When the file holds something
   * else right before the rename (Claude Code or the user wrote it meanwhile), nothing is
   * written and writeSettings returns false.
   */
  unchangedFrom?: string | null
}

/**
 * Writes settings.json atomically with mode 0600, pretty printed as Claude Code does. True
 * when written; false only when `unchangedFrom` no longer matches.
 */
export function writeSettings(
  file: string,
  settings: Json,
  options: WriteSettingsOptions = {}
): boolean {
  const target = writeTarget(file)
  const content = JSON.stringify(settings, null, 2)
  const { unchangedFrom } = options
  if (unchangedFrom === undefined) {
    return writeFileAtomicSync(target, content, renameFile, SETTINGS_MODE)
  }
  return writeFileAtomicSync(
    target,
    content,
    renameFile,
    SETTINGS_MODE,
    () => readTextOrNull(file) === unchangedFrom
  )
}

/** What an update makes of the current settings. */
export type SettingsChange = Json | 'unchanged' | 'invalid'
export type SettingsUpdateResult = 'written' | 'unchanged' | 'invalid'

/** Attempts when settings.json changes between reading it and replacing it. */
export const SETTINGS_UPDATE_ATTEMPTS = 3

/**
 * Read, change, write settings.json without losing a concurrent write: the file is read again
 * right before the rename and the whole update starts over when it changed meanwhile. A file
 * that is not a JSON object is reported as invalid and never touched.
 */
export function updateSettings(
  file: string,
  change: (settings: Json) => SettingsChange,
  attempts: number = SETTINGS_UPDATE_ATTEMPTS
): SettingsUpdateResult {
  for (let attempt = 1; ; attempt++) {
    const text = readTextOrNull(file)
    const settings = parseSettings(text)
    if (!settings) return 'invalid'
    const next = change(settings)
    if (next === 'unchanged' || next === 'invalid') return next
    if (writeSettings(file, next, { unchangedFrom: text })) return 'written'
    if (attempt >= attempts) throw new Error('settings.json kept changing while it was updated')
  }
}

/** Atomic write that skips files already holding `content`; true when it wrote. */
export function writeIfChanged(file: string, content: string, mode: number): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  writeFileAtomic(file, content, mode)
  return true
}
