import { describe, expect, it } from 'vitest'
import {
  descendants,
  encodePowerShell,
  listProcesses,
  parseLstart,
  parsePsOutput,
  parseWindowsProcessList,
  PS_ARGS,
  WINDOWS_PROCESS_SCRIPT
} from './processList'

const PS = `    1     0     1 Thu Oct  1 18:42:13 2026     /sbin/launchd
  500     1   500 Tue Oct  7 09:05:00 2026     /bin/zsh -ilc exec env claude --session-id x
  510   500   510 Tue Oct  7 10:22:33 2026     /bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'pnpm test' \\< /dev/null
  511   510   510 Tue Oct  7 10:22:34 2026     node /code/app/node_modules/.bin/vitest run
  junk line
  512   511   510 Tue Oct  7 10:22:34 2026
  513     1   513 Tue Okt  7 10:22:34 2026     odd date
`

describe('parsePsOutput', () => {
  it('reads pid, ppid, pgid and the full command line', () => {
    const list = parsePsOutput(PS)
    expect(list).toHaveLength(5)
    // An unreadable start time is kept as unknown (such a process can never be stopped).
    expect(list[4]).toMatchObject({ pid: 513, startMs: null, command: 'odd date' })
    expect(list[2]).toEqual({
      pid: 510,
      ppid: 500,
      pgid: 510,
      startMs: new Date(2026, 9, 7, 10, 22, 33).getTime(),
      command:
        "/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'pnpm test' \\< /dev/null"
    })
    expect(list[3].command).toBe('node /code/app/node_modules/.bin/vitest run')
  })
})

describe('parseLstart', () => {
  it('reads C locale start times as local time and refuses anything else', () => {
    expect(parseLstart('Tue Oct  7 10:22:33 2026')).toBe(new Date(2026, 9, 7, 10, 22, 33).getTime())
    expect(parseLstart('Mon Jan 12 00:00:00 2026')).toBe(new Date(2026, 0, 12).getTime())
    expect(parseLstart('Sal Eki  7 10:22:33 2026')).toBeNull()
    expect(parseLstart('Tue Oct 7 25:00:00 2026')).toBeNull()
    expect(parseLstart('')).toBeNull()
  })
})

describe('parseWindowsProcessList', () => {
  it('reads tab separated lines with CRLF and empty command lines', () => {
    const text =
      '4\t0\t\t\r\n900\t4\t1791367353123\tC:\\Program Files\\Git\\bin\\bash.exe -c "eval \'npm test\'"\r\nbad\r\n'
    expect(parseWindowsProcessList(text)).toEqual([
      { pid: 4, ppid: 0, pgid: null, startMs: null, command: '' },
      {
        pid: 900,
        ppid: 4,
        pgid: null,
        startMs: 1791367353123,
        command: 'C:\\Program Files\\Git\\bin\\bash.exe -c "eval \'npm test\'"'
      }
    ])
  })
})

describe('listProcesses', () => {
  it('runs ps with fixed arguments on POSIX', async () => {
    const calls: [string, string[]][] = []
    const list = await listProcesses('darwin', (file, args) => {
      calls.push([file, args])
      return Promise.resolve(PS)
    })
    expect(calls).toEqual([['/usr/bin/env', ['LC_ALL=C', '/bin/ps', ...PS_ARGS]]])
    expect(list).toHaveLength(5)
  })

  it('runs Windows PowerShell from SystemRoot with an encoded script', async () => {
    const calls: [string, string[]][] = []
    await listProcesses(
      'win32',
      (file, args) => {
        calls.push([file, args])
        return Promise.resolve('1\t0\t\tx')
      },
      { SystemRoot: 'D:\\Win' }
    )
    expect(calls).toEqual([
      [
        'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encodePowerShell(WINDOWS_PROCESS_SCRIPT)
        ]
      ]
    ])
    expect(Buffer.from(calls[0][1][3], 'base64').toString('utf16le')).toBe(WINDOWS_PROCESS_SCRIPT)
  })
})

describe('descendants', () => {
  it('walks the tree below a pid, ignoring cycles', () => {
    const list = parsePsOutput(PS)
    expect(descendants(list, 500).map((p) => p.pid)).toEqual([510, 511])
    expect(descendants(list, 511)).toEqual([])
    const cyclic = [
      { pid: 2, ppid: 3, pgid: null, startMs: null, command: '' },
      { pid: 3, ppid: 2, pgid: null, startMs: null, command: '' }
    ]
    expect(descendants(cyclic, 2).map((p) => p.pid)).toEqual([3])
  })
})
