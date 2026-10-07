import { resolveBaseEnv } from './env'
import { copyRunner, renameWithRetry, rmWithRetry } from './fs'
import { claudeLaunch, claudeLocator, shellLaunch } from './launch'
import { permissionRulePath } from './paths'
import { killTree, spawnDefaults } from './processTree'
import type { OsName, Platform } from './types'

export type {
  ClaudeLocator,
  CopyRunner,
  Env,
  KillTree,
  LaunchSpec,
  OsName,
  Platform
} from './types'

/** Binds every platform function to one OS; tests build a win32 platform on a Mac. */
export function createPlatform(os: OsName): Platform {
  return {
    os,
    resolveBaseEnv: () => resolveBaseEnv(os),
    claudeLaunch: (configDir, claudeArgs, baseEnv) =>
      claudeLaunch(os, configDir, claudeArgs, baseEnv),
    shellLaunch: (configDir, baseEnv) => shellLaunch(os, configDir, baseEnv),
    spawnDefaults: () => spawnDefaults(os),
    killTree: killTree(os),
    claudeLocator: claudeLocator(os),
    permissionRulePath: (abs) => permissionRulePath(abs, os),
    renameWithRetry: renameWithRetry(os),
    rmWithRetry: rmWithRetry(os),
    copyRunner: copyRunner(os)
  }
}

export const platform: Platform = createPlatform(process.platform)
