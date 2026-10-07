import { execFile } from 'node:child_process'
import { buildSessionEnv, claudeCommand, defaultShell } from '../env/shellEnv'
import {
  CLAUDE_BIN,
  LOGIN_SHELL_ARGS,
  LOGIN_SHELL_COMMAND_FLAG,
  NOT_IMPLEMENTED,
  WHICH_PATH
} from './constants'
import type { ClaudeLocator, Env, LaunchSpec, OsName } from './types'

/**
 * macOS: claude runs through the login shell (`-ilc`) so rc files set PATH; the command line
 * re-applies CLAUDE_CONFIG_DIR and drops credential variables that rc files may export.
 */
export function claudeLaunch(
  os: OsName,
  configDir: string,
  claudeArgs: string[],
  baseEnv: Env
): LaunchSpec {
  if (os === 'win32') throw new Error(NOT_IMPLEMENTED)
  return {
    file: defaultShell(baseEnv),
    args: [LOGIN_SHELL_COMMAND_FLAG, claudeCommand(configDir, claudeArgs)],
    env: buildSessionEnv(baseEnv, { configDir })
  }
}

/** Interactive login shell for a terminal tab, with the account's config dir in its env. */
export function shellLaunch(os: OsName, configDir: string, baseEnv: Env): LaunchSpec {
  if (os === 'win32') throw new Error(NOT_IMPLEMENTED)
  return {
    file: defaultShell(baseEnv),
    args: [...LOGIN_SHELL_ARGS],
    env: buildSessionEnv(baseEnv, { configDir })
  }
}

const posixLocator: ClaudeLocator = {
  available: (env) =>
    new Promise((done) => execFile(WHICH_PATH, [CLAUDE_BIN], { env }, (error) => done(!error))),
  // execFile looks the name up on the env's PATH.
  file: () => Promise.resolve(CLAUDE_BIN)
}

const win32Locator: ClaudeLocator = {
  available: () => Promise.reject(new Error(NOT_IMPLEMENTED)),
  file: () => Promise.reject(new Error(NOT_IMPLEMENTED))
}

export function claudeLocator(os: OsName): ClaudeLocator {
  return os === 'win32' ? win32Locator : posixLocator
}
