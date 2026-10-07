import { existsSync, readFileSync, rmSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { writeFileAtomic } from '../profile/guidelines'

type Json = Record<string, unknown>

/**
 * Top-level settings.json keys that make Claude Code run commands or redirect credentials.
 * An optimize run may never change them; deny rules cannot express "edit the file but not
 * these keys", so they are put back after the run.
 */
export const PROTECTED_SETTINGS_KEYS = [
  'hooks',
  'statusLine',
  'apiKeyHelper',
  'env',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper'
] as const

const PERMISSIONS = 'permissions'
const DEFAULT_MODE = 'defaultMode'
/** Label of the nested `permissions.defaultMode` key. */
export const DEFAULT_MODE_KEY = `${PERMISSIONS}.${DEFAULT_MODE}`
/** Label used when the whole file had to be restored (it was no longer a JSON object). */
export const WHOLE_FILE = 'settings.json'

const SETTINGS_MODE = 0o600

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** File text, or null when the file does not exist. */
export function readSettingsText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Parsed object; {} for a missing or empty file, null when it is not a JSON object. */
function parse(text: string | null): Json | null {
  if (text === null || text.trim() === '') return {}
  try {
    const json: unknown = JSON.parse(text)
    return isObject(json) ? json : null
  } catch {
    return null
  }
}

const defaultModeOf = (settings: Json): unknown =>
  isObject(settings[PERMISSIONS]) ? settings[PERMISSIONS][DEFAULT_MODE] : undefined

/** Sets `key` to `value` on `target`, or removes it when the value is undefined. */
function put(target: Json, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/**
 * Puts the protected keys of `file` back to their values in `before` (the file text before the
 * run, null when it did not exist). Every other edit is kept. Returns the labels of the keys
 * that were restored; empty when nothing had to change.
 *
 * A settings file that was unreadable before the run counts as empty (Claude Code ignored it).
 * One that is no longer a JSON object afterwards is restored as a whole.
 */
export function restoreProtectedSettings(file: string, before: string | null): string[] {
  const after = readSettingsText(file)
  if (after === null || after === before) return []
  const previous = parse(before) ?? {}
  const current = parse(after)
  if (current === null) {
    if (before === null) rmSync(file, { force: true })
    else writeFileAtomic(file, before, SETTINGS_MODE)
    return [WHOLE_FILE]
  }

  const restored: string[] = []
  const next: Json = { ...current }
  for (const key of PROTECTED_SETTINGS_KEYS) {
    if (isDeepStrictEqual(previous[key], current[key])) continue
    put(next, key, previous[key])
    restored.push(key)
  }

  const mode = defaultModeOf(previous)
  if (!isDeepStrictEqual(mode, defaultModeOf(current))) {
    const permissions: Json = isObject(current[PERMISSIONS]) ? { ...current[PERMISSIONS] } : {}
    put(permissions, DEFAULT_MODE, mode)
    const keep = Object.keys(permissions).length > 0 || previous[PERMISSIONS] !== undefined
    put(next, PERMISSIONS, keep ? permissions : undefined)
    restored.push(DEFAULT_MODE_KEY)
  }

  if (restored.length > 0) {
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, SETTINGS_MODE)
  }
  return restored
}
