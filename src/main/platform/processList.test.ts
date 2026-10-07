import { describe, expect, it } from 'vitest'
import {
  descendants,
  encodePowerShell,
  listProcesses,
  parsePsOutput,
  parseWindowsProcessList,
  PS_ARGS,
  WINDOWS_PROCESS_SCRIPT
} from './processList'

const PS = `    1     0     1 /sbin/launchd
  500     1   500 /bin/zsh -ilc exec env claude --session-id x
  510   500   510 /bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'pnpm test' \\< /dev/null
  511   510   510 node /code/app/node_modules/.bin/vitest run
  junk line
  512   511   510
`

describe('parsePsOutput', () => {
  it('reads pid, ppid, pgid and the full command line', () => {
    const list = parsePsOutput(PS)
    expect(list).toHaveLength(4)
    expect(list[2]).toEqual({
      pid: 510,
      ppid: 500,
      pgid: 510,
      command:
        "/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'pnpm test' \\< /dev/null"
    })
    expect(list[3].command).toBe('node /code/app/node_modules/.bin/vitest run')
  })
})

describe('parseWindowsProcessList', () => {
  it('reads tab separated lines with CRLF and empty command lines', () => {
    const text =
      '4\t0\t\r\n900\t4\tC:\\Program Files\\Git\\bin\\bash.exe -c "eval \'npm test\'"\r\nbad\r\n'
    expect(parseWindowsProcessList(text)).toEqual([
      { pid: 4, ppid: 0, pgid: null, command: '' },
      {
        pid: 900,
        ppid: 4,
        pgid: null,
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
    expect(calls).toEqual([['/bin/ps', PS_ARGS]])
    expect(list).toHaveLength(4)
  })

  it('runs Windows PowerShell from SystemRoot with an encoded script', async () => {
    const calls: [string, string[]][] = []
    await listProcesses(
      'win32',
      (file, args) => {
        calls.push([file, args])
        return Promise.resolve('1\t0\tx')
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
      { pid: 2, ppid: 3, pgid: null, command: '' },
      { pid: 3, ppid: 2, pgid: null, command: '' }
    ]
    expect(descendants(cyclic, 2).map((p) => p.pid)).toEqual([3])
  })
})
