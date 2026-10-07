import { execFile } from 'node:child_process'
import { renameSync, rmSync, type RmOptions } from 'node:fs'
import { promisify } from 'node:util'
import { COPY_TIMEOUT_MS, NOT_IMPLEMENTED } from './constants'
import type { CopyRunner, OsName } from './types'

const execFileAsync = promisify(execFile)

/** APFS clone through `cp -c`; fails on other volumes or file systems. */
export const cloneCopy: CopyRunner = async (src, dest, dereference) => {
  await execFileAsync('/bin/cp', [dereference ? '-cRLp' : '-cRp', src, dest], {
    timeout: COPY_TIMEOUT_MS
  })
}

const notImplemented = (): never => {
  throw new Error(NOT_IMPLEMENTED)
}

/** POSIX rename is atomic and not blocked by open handles; Windows will retry EPERM/EBUSY. */
export function renameWithRetry(os: OsName): (from: string, to: string) => void {
  return os === 'win32' ? notImplemented : (from, to) => renameSync(from, to)
}

export function rmWithRetry(os: OsName): (path: string, options?: RmOptions) => void {
  return os === 'win32' ? notImplemented : (path, options) => rmSync(path, options)
}

export function copyRunner(os: OsName): CopyRunner {
  return os === 'win32' ? () => Promise.reject(new Error(NOT_IMPLEMENTED)) : cloneCopy
}
