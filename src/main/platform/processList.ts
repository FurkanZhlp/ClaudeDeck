import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { WIN_DEFAULT_SYSTEM_ROOT, WIN_POWERSHELL } from './constants'
import type { OsName } from './types'

/** One running process; `pgid` is null on Windows (no process groups). */
export interface ProcessInfo {
  pid: number
  ppid: number
  pgid: number | null
  command: string
}

/** Runs a fixed executable with fixed arguments and resolves its stdout. */
export type RunFile = (file: string, args: string[]) => Promise<string>

const PS = '/bin/ps'
/** Every process, full command lines (`ww`), no header (`=`). */
export const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,pgid=,command=']

/**
 * Tab separated `pid ppid commandline`, one per line; line breaks and tabs inside a command line
 * become spaces. UTF-8 output so non-ASCII paths survive.
 */
export const WINDOWS_PROCESS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '"$($_.ProcessId)`t$($_.ParentProcessId)`t$(($_.CommandLine) -replace "[\\r\\n\\t]+", " ")"',
  '}'
].join('; ')

const EXEC_TIMEOUT_MS = 10_000
const MAX_BUFFER = 32 * 1024 * 1024

const isPid = (n: number): boolean => Number.isInteger(n) && n >= 0

/** `ps -o pid=,ppid=,pgid=,command=` output. */
export function parsePsOutput(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (!match) continue
    const [pid, ppid, pgid] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (!isPid(pid) || !isPid(ppid) || !isPid(pgid)) continue
    out.push({ pid, ppid, pgid, command: match[4].trim() })
  }
  return out
}

/** Output of WINDOWS_PROCESS_SCRIPT. */
export function parseWindowsProcessList(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(\d+)\t(\d+)\t(.*)$/.exec(raw)
    if (!match) continue
    const [pid, ppid] = [Number(match[1]), Number(match[2])]
    if (!isPid(pid) || !isPid(ppid)) continue
    out.push({ pid, ppid, pgid: null, command: match[3].trim() })
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
  return parsePsOutput(await run(PS, PS_ARGS))
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
