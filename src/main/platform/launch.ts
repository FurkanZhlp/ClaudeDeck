import { win32 } from 'node:path'
import { DomainError } from '../../shared/errors'
import { buildSessionEnv, claudeCommand, defaultShell, getEnv, sanitizeEnv } from '../env/shellEnv'
import {
  findOnWindowsPath,
  locateClaudeWindows,
  nodeLocatorFs,
  type LocatorFs
} from './claudeLocator'
import {
  LOGIN_SHELL_ARGS,
  LOGIN_SHELL_COMMAND_FLAG,
  POWERSHELL_ARGS,
  WIN_CMD,
  WIN_DEFAULT_SYSTEM_ROOT,
  WIN_POWERSHELL,
  WIN_PWSH
} from './constants'
import type { Env, LaunchSpec, OsName } from './types'

const NO_CWD_EXE_SEARCH = 'NoDefaultCurrentDirectoryInExePath'

/**
 * Windows has no shell in between to re-apply the account: credential variables and any
 * inherited CLAUDE_CONFIG_DIR are removed from the env object (in any case) before it is set.
 * NoDefaultCurrentDirectoryInExePath keeps cmd and PowerShell from running an executable of the
 * same name found in the current folder (a cloned project) instead of the one on Path.
 */
function windowsSessionEnv(baseEnv: Env, configDir: string): Env {
  const env = buildSessionEnv(sanitizeEnv(baseEnv, 'win32'), { configDir })
  // Names are case-insensitive on Windows; drop any other spelling before setting ours.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === NO_CWD_EXE_SEARCH.toUpperCase()) delete env[key]
  }
  return { ...env, [NO_CWD_EXE_SEARCH]: '1' }
}

/**
 * macOS: claude runs through the login shell (`-ilc`) so rc files set PATH; the command line
 * re-applies CLAUDE_CONFIG_DIR and drops credential variables that rc files may export.
 * Windows: the located `claude.exe` is started directly.
 */
export function claudeLaunch(
  os: OsName,
  configDir: string,
  claudeArgs: string[],
  baseEnv: Env,
  fs: LocatorFs = nodeLocatorFs
): LaunchSpec {
  if (os === 'win32') {
    const env = windowsSessionEnv(baseEnv, configDir)
    const file = locateClaudeWindows(env, fs)
    if (!file) throw new DomainError('CLAUDE_NOT_FOUND')
    return { file, args: [...claudeArgs], env }
  }
  return {
    file: defaultShell(baseEnv),
    args: [LOGIN_SHELL_COMMAND_FLAG, claudeCommand(configDir, claudeArgs)],
    env: buildSessionEnv(baseEnv, { configDir })
  }
}

/** PowerShell 7 on the search path, else Windows PowerShell, else `%ComSpec%`. */
export function windowsShell(env: Env, fs: LocatorFs): string {
  const pwsh = findOnWindowsPath(env, WIN_PWSH, fs)
  if (pwsh) return pwsh
  const systemRoot = getEnv(env, 'SystemRoot', 'win32') || WIN_DEFAULT_SYSTEM_ROOT
  const powershell = win32.join(systemRoot, ...WIN_POWERSHELL)
  if (fs.isFile(powershell)) return powershell
  return getEnv(env, 'ComSpec', 'win32') || win32.join(systemRoot, ...WIN_CMD)
}

/** Interactive shell for a terminal tab, with the account's config dir in its env. */
export function shellLaunch(
  os: OsName,
  configDir: string,
  baseEnv: Env,
  fs: LocatorFs = nodeLocatorFs
): LaunchSpec {
  if (os === 'win32') {
    const env = windowsSessionEnv(baseEnv, configDir)
    const file = windowsShell(env, fs)
    const isPowerShell = /^(pwsh|powershell)\.exe$/i.test(win32.basename(file))
    return { file, args: isPowerShell ? [...POWERSHELL_ARGS] : [], env }
  }
  return {
    file: defaultShell(baseEnv),
    args: [...LOGIN_SHELL_ARGS],
    env: buildSessionEnv(baseEnv, { configDir })
  }
}
