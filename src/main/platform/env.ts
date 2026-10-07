import { resolveShellEnv } from '../env/shellEnv'
import { NOT_IMPLEMENTED } from './constants'
import type { Env, OsName } from './types'

/** The env child processes start from. macOS: the user's login shell env, read once. */
export function resolveBaseEnv(os: OsName): Promise<Env> {
  if (os === 'win32') return Promise.reject(new Error(NOT_IMPLEMENTED))
  return resolveShellEnv()
}
