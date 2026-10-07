import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { WIN_DEFAULT_SYSTEM_ROOT, WIN_POWERSHELL } from './constants'
import type { OsName } from './types'

/** One running process; `pgid` is null on Windows (no process groups). */
export interface ProcessInfo {
  pid: number
  ppid: number
  pgid: number | null
  /** Start time (epoch ms; whole seconds on POSIX), null when it could not be read. */
  startMs: number | null
  command: string
}

/** Runs a fixed executable with fixed arguments and resolves its stdout. */
export type RunFile = (file: string, args: string[]) => Promise<string>

const PS = '/bin/ps'
const ENV = '/usr/bin/env'
/**
 * Every process, full command lines (`ww`), no header (`=`). `lstart` is the start time as
 * `Tue Oct  7 10:22:33 2026` (local time); `LC_ALL=C` keeps it in English.
 */
export const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command=']
const PS_ENV_ARGS = ['LC_ALL=C', PS, ...PS_ARGS]

/**
 * Tab separated `pid ppid startMs commandline`, one per line (startMs empty when unknown); line
 * breaks and tabs inside a command line become spaces. UTF-8 output so non-ASCII paths survive.
 */
export const WINDOWS_PROCESS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '$s = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { "" }',
  '"$($_.ProcessId)`t$($_.ParentProcessId)`t$s`t$(($_.CommandLine) -replace "[\\r\\n\\t]+", " ")"',
  '}'
].join('; ')

const EXEC_TIMEOUT_MS = 10_000
const MAX_BUFFER = 32 * 1024 * 1024

const isPid = (n: number): boolean => Number.isInteger(n) && n >= 0

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `Tue Oct  7 10:22:33 2026` as `ps -o lstart` prints it in the C locale. */
const LSTART = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/

/** Local time of an `lstart` value in epoch ms, or null when it does not parse. */
export function parseLstart(text: string): number | null {
  const match = LSTART.exec(text.trim())
  if (!match) return null
  const month = MONTHS.indexOf(match[1])
  const [day, hour, minute, second, year] = match.slice(2).map(Number)
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null
  const ms = new Date(year, month, day, hour, minute, second).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** `ps -o pid=,ppid=,pgid=,lstart=,command=` output. */
export function parsePsOutput(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s(.*)$/.exec(
        line
      )
    if (!match) continue
    const [pid, ppid, pgid] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (!isPid(pid) || !isPid(ppid) || !isPid(pgid)) continue
    out.push({ pid, ppid, pgid, startMs: parseLstart(match[4]), command: match[5].trim() })
  }
  return out
}

/** Output of WINDOWS_PROCESS_SCRIPT. */
export function parseWindowsProcessList(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(\d+)\t(\d+)\t(\d*)\t(.*)$/.exec(raw)
    if (!match) continue
    const [pid, ppid] = [Number(match[1]), Number(match[2])]
    if (!isPid(pid) || !isPid(ppid)) continue
    const start = match[3] ? Number(match[3]) : NaN
    const startMs = Number.isSafeInteger(start) && start > 0 ? start : null
    out.push({ pid, ppid, pgid: null, startMs, command: match[4].trim() })
  }
  return out
}

/** execFile with a timeout and no shell; arguments are passed as they are. */
export const runFile: RunFile = (file, args) =>
  new Promise((done, fail) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error ? fail(error) : done(String(stdout)))
    )
  })

/** Windows PowerShell 5.1 from %SystemRoot%, never looked up on PATH. */
const windowsPowerShell = (env: Record<string, string | undefined>): string =>
  win32.join(env.SystemRoot || WIN_DEFAULT_SYSTEM_ROOT, ...WIN_POWERSHELL)

/** -EncodedCommand form (UTF-16LE base64): no command line quoting rules involved. */
export const encodePowerShell = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64')

/** Every process with its parent and command line. */
export async function listProcesses(
  os: OsName,
  run: RunFile = runFile,
  env: Record<string, string | undefined> = process.env
): Promise<ProcessInfo[]> {
  if (os === 'win32') {
    const text = await run(windowsPowerShell(env), [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(WINDOWS_PROCESS_SCRIPT)
    ])
    return parseWindowsProcessList(text)
  }
  return parsePsOutput(await run(ENV, PS_ENV_ARGS))
}

/** Processes below `rootPid` (not the root itself), parents before children. */
export function descendants(list: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>()
  for (const p of list) {
    if (p.pid === p.ppid) continue
    const siblings = children.get(p.ppid)
    if (siblings) siblings.push(p)
    else children.set(p.ppid, [p])
  }
  const out: ProcessInfo[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}
