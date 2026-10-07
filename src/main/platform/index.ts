import { resolveBaseEnv } from './env'
import { copyRunner, rmWithRetry } from './fs'
import { claudeLocator, nodeLocatorFs, type LocatorFs } from './claudeLocator'
import { claudeLaunch, shellLaunch } from './launch'
import { permissionRulePath } from './paths'
import { listProcesses } from './processList'
import { killTree, spawnDefaults } from './processTree'
import type { OsName, Platform } from './types'
export type { ProcessInfo } from './processList'

export type {
  ClaudeLocator,
  CopyRunner,
  Env,
  KillTree,
  LaunchSpec,
  OsName,
  Platform
} from './types'

/**
 * Binds every platform function to one OS; tests build a win32 platform on a Mac and pass a
 * fake `fs` for locating `claude.exe` and the shell.
 */
export function createPlatform(os: OsName, fs: LocatorFs = nodeLocatorFs): Platform {
  return {
    os,
    resolveBaseEnv: () => resolveBaseEnv(os),
    claudeLaunch: (configDir, claudeArgs, baseEnv) =>
      claudeLaunch(os, configDir, claudeArgs, baseEnv, fs),
    shellLaunch: (configDir, baseEnv) => shellLaunch(os, configDir, baseEnv, fs),
    spawnDefaults: () => spawnDefaults(os),
    killTree: killTree(os),
    claudeLocator: claudeLocator(os, fs),
    permissionRulePath: (abs) => permissionRulePath(abs, os),
    rmWithRetry: rmWithRetry(os),
    copyRunner: copyRunner(os),
    listProcesses: () => listProcesses(os)
  }
}

export const platform: Platform = createPlatform(process.platform)
