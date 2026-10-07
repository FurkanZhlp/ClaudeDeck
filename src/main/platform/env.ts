import { homedir } from 'node:os'
import { getEnv, resolveShellEnv, sanitizeEnv, withFallbackPath } from '../env/shellEnv'
import type { Env, OsName } from './types'

/**
 * Windows: no login shell; the app's own env (case-normalized, credentials stripped) plus the
 * usual Claude Code install dirs on `Path`.
 */
export function windowsBaseEnv(source: Record<string, string | undefined>, home: string): Env {
  const env = sanitizeEnv(source, 'win32')
  return withFallbackPath(env, getEnv(env, 'USERPROFILE', 'win32') || home, 'win32')
}

/**
 * `env` with the `extra` variables set. Names are case-insensitive on Windows: any other
 * spelling of an extra name is dropped first, or the child would see whichever copy wins.
 */
export function withEnvVars(env: Env, extra: Env, os: OsName): Env {
  if (os !== 'win32') return { ...env, ...extra }
  const names = new Set(Object.keys(extra).map((name) => name.toUpperCase()))
  const kept = Object.entries(env).filter(([name]) => !names.has(name.toUpperCase()))
  return { ...Object.fromEntries(kept), ...extra }
}

/** The env child processes start from. macOS: the user's login shell env, read once. */
export function resolveBaseEnv(os: OsName): Promise<Env> {
  // Not cached on Windows: it is cheap, and a Claude install made while the app runs shows up.
  if (os === 'win32') return Promise.resolve(windowsBaseEnv(process.env, homedir()))
  return resolveShellEnv()
}
