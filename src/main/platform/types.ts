import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { RmOptions } from 'node:fs'

export type Env = Record<string, string>

/** `process.platform` values; only `darwin` and `win32` are supported targets. */
export type OsName = 'darwin' | 'win32' | NodeJS.Platform

/** What to hand to `spawn` / `pty.spawn`: executable, arguments and the full env. */
export interface LaunchSpec {
  file: string
  args: string[]
  env: Env
}

export type KillTree = (child: ChildProcess, signal: NodeJS.Signals) => void

export type CopyRunner = (src: string, dest: string, dereference: boolean) => Promise<void>

/** Finds the `claude` executable for headless calls (`auth status`, `auth logout`). */
export interface ClaudeLocator {
  /** True when `claude` can be started with this env. */
  available(env: Env): Promise<boolean>
  /** Executable to pass to `execFile`. */
  file(env: Env): Promise<string>
}

/** Every OS-dependent operation of the main process. */
export interface Platform {
  readonly os: OsName
  /** The env child processes start from (login shell env on macOS). */
  resolveBaseEnv(): Promise<Env>
  /** Starts `claude` with the account's config dir. */
  claudeLaunch(configDir: string, claudeArgs: string[], baseEnv: Env): LaunchSpec
  /** Starts the user's interactive shell for a terminal tab. */
  shellLaunch(configDir: string, baseEnv: Env): LaunchSpec
  /** Extra `spawn` options so `killTree` can reach the whole process tree. */
  spawnDefaults(): Pick<SpawnOptions, 'detached' | 'windowsHide'>
  killTree: KillTree
  claudeLocator: ClaudeLocator
  /** Absolute path in Claude Code permission rule syntax (`Read(<here>/x)`). */
  permissionRulePath(abs: string): string
  renameWithRetry(from: string, to: string): void
  rmWithRetry(path: string, options?: RmOptions): void
  copyRunner: CopyRunner
}
