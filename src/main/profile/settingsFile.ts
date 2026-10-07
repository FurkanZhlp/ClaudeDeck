import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './guidelines'

/** Mode for an account's settings.json and other private files ClaudeDeck writes there. */
export const SETTINGS_MODE = 0o600

export type Json = Record<string, unknown>

export const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export const settingsPath = (configDir: string): string => join(configDir, 'settings.json')

/** Parsed settings.json; {} when missing or empty, null when it is not a JSON object. */
export function readSettings(file: string): Json | null {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  if (text.trim() === '') return {}
  try {
    const json: unknown = JSON.parse(text)
    return isObject(json) ? json : null
  } catch {
    return null
  }
}

/** Writes settings.json atomically with mode 0600, pretty printed as Claude Code does. */
export function writeSettings(file: string, settings: Json): void {
  writeFileAtomic(file, JSON.stringify(settings, null, 2), SETTINGS_MODE)
}

/** Atomic write that skips files already holding `content`; true when it wrote. */
export function writeIfChanged(file: string, content: string, mode: number): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  writeFileAtomic(file, content, mode)
  return true
}
