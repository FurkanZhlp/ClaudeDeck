import { execFileSync } from 'node:child_process'
import type { OsName } from '../platform/types'

/** ClaudeDeck's own process as the hook script checks it: pid and start time. */
export interface ProcessIdentity {
  pid: number
  /** `ps -o lstart=` with blanks collapsed (C locale); null where it cannot be read. */
  startTime: string | null
}

/**
 * Start time of a process the way the hook script reads it (`LC_ALL=C ps -o lstart= -p PID`),
 * so a reused pid is not taken for ClaudeDeck. Null on Windows (the script does not check the
 * process there) and when ps fails.
 */
export function processStartTime(
  pid: number,
  os: OsName,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' }
    })
): string | null {
  if (os === 'win32' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const text = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)])
      .replace(/\s+/g, ' ')
      .trim()
    return text || null
  } catch {
    return null
  }
}

/** This process, read once. */
export function currentProcessIdentity(os: OsName = process.platform): ProcessIdentity {
  return { pid: process.pid, startTime: processStartTime(process.pid, os) }
}
