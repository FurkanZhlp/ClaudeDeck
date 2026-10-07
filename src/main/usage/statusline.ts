import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { OsName } from '../platform/types'
import { writeFileAtomic } from '../profile/guidelines'
import {
  chainShellFor,
  findGitBash,
  ORIGINAL_FILE,
  OURS,
  posixStatuslineCommand,
  posixStatuslineScript,
  SCRIPT_FILES,
  scriptFileName,
  USAGE_RAW_FILE,
  windowsPowerShellPath,
  windowsStatuslineCommand,
  windowsStatuslineScript
} from './statuslineScript'

export { USAGE_RAW_FILE } from './statuslineScript'

const SETTINGS_MODE = 0o600
const SCRIPT_MODE = 0o755

type Json = Record<string, unknown>

export const usageDir = (configDir: string): string => join(configDir, 'claudedeck')
export const usageRawPath = (configDir: string): string => join(usageDir(configDir), USAGE_RAW_FILE)
export const statuslineScriptPath = (configDir: string, os: OsName = process.platform): string =>
  join(usageDir(configDir), scriptFileName(os))
const originalPath = (configDir: string): string => join(usageDir(configDir), ORIGINAL_FILE)
const settingsPath = (configDir: string): string => join(configDir, 'settings.json')

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const isOurs = (statusLine: unknown): boolean =>
  isObject(statusLine) && typeof statusLine.command === 'string' && OURS.test(statusLine.command)

/** The host the statusline is installed for; tests pass a Windows host on a Mac. */
export interface StatuslineHost {
  os: OsName
  /** Env used to find Git Bash on Windows. */
  env: Record<string, string | undefined>
  exists?: (path: string) => boolean
}

const currentHost = (): StatuslineHost => ({ os: process.platform, env: process.env })

/** Script text and settings.json command for the host; command is null when it cannot be quoted. */
function render(
  host: StatuslineHost,
  dir: string,
  scriptPath: string,
  originalCommand: string | null
): { script: string; command: string | null } {
  if (host.os !== 'win32') {
    return {
      script: posixStatuslineScript(dir, originalCommand),
      command: posixStatuslineCommand(scriptPath)
    }
  }
  // Chosen now rather than per run: the script must start fast.
  const powershell = windowsPowerShellPath(host.env)
  const shell = chainShellFor(
    originalCommand ? findGitBash(host.env, host.exists) : null,
    powershell
  )
  return {
    script: windowsStatuslineScript(dir, originalCommand, shell),
    command: windowsStatuslineCommand(scriptPath, powershell)
  }
}

/** Parsed settings.json; {} when missing or empty, null when it is not a JSON object. */
function readSettings(file: string): Json | null {
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

function readOriginal(configDir: string): Json | null {
  try {
    const json: unknown = JSON.parse(readFileSync(originalPath(configDir), 'utf8'))
    return isObject(json) ? json : null
  } catch {
    return null
  }
}

const commandOf = (statusLine: Json | null): string | null =>
  statusLine && typeof statusLine.command === 'string' && statusLine.command.trim() !== ''
    ? statusLine.command
    : null

const writeIfChanged = (file: string, content: string, mode: number): boolean => {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  writeFileAtomic(file, content, mode)
  return true
}

/**
 * Points the account's statusline at ClaudeDeck's script, keeping any statusline the account
 * already had as the chained original. Only the `statusLine` key is touched. Returns true when
 * anything changed; leaves invalid settings.json alone (returns false).
 */
export function installStatusline(
  configDir: string,
  host: StatuslineHost = currentHost()
): boolean {
  const scriptPath = statuslineScriptPath(configDir, host.os)
  const file = settingsPath(configDir)
  const settings = readSettings(file)
  if (!settings) {
    console.warn('[usage] settings.json is not valid JSON; statusline not installed')
    return false
  }

  let changed = false
  const current = settings.statusLine
  let original: Json | null = null
  if (isOurs(current)) {
    original = readOriginal(configDir)
  } else if (isObject(current)) {
    // A statusline that is not ours is the user's latest one; it becomes the chained original.
    original = current
    changed = writeIfChanged(originalPath(configDir), JSON.stringify(current, null, 2), 0o600)
  } else if (existsSync(originalPath(configDir))) {
    // No usable statusline left, so a previously saved original is stale.
    rmSync(originalPath(configDir), { force: true })
    changed = true
  }

  const { script, command } = render(host, usageDir(configDir), scriptPath, commandOf(original))
  if (command === null) {
    console.warn('[usage] statusline path cannot be quoted for every shell; not installed')
    return changed
  }
  changed = writeIfChanged(scriptPath, script, SCRIPT_MODE) || changed

  const extras = isObject(original) ? { ...original } : {}
  delete extras.type
  delete extras.command
  const entry = { ...extras, type: 'command', command }
  if (JSON.stringify(current) !== JSON.stringify(entry)) {
    writeFileAtomic(
      file,
      JSON.stringify({ ...settings, statusLine: entry }, null, 2),
      SETTINGS_MODE
    )
    changed = true
  }
  return changed
}

/** Restores the original statusline (or removes ours) and deletes ClaudeDeck's script files. */
export function uninstallStatusline(configDir: string): boolean {
  const file = settingsPath(configDir)
  const settings = readSettings(file)
  let changed = false
  if (settings && isOurs(settings.statusLine)) {
    const original = readOriginal(configDir)
    const next = { ...settings }
    if (original) next.statusLine = original
    else delete next.statusLine
    writeFileAtomic(file, JSON.stringify(next, null, 2), SETTINGS_MODE)
    changed = true
  }
  const scripts = SCRIPT_FILES.map((name) => join(usageDir(configDir), name))
  for (const path of [...scripts, originalPath(configDir)]) {
    if (existsSync(path)) {
      rmSync(path, { force: true })
      changed = true
    }
  }
  return changed
}
