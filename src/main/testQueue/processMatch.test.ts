import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../platform/processList'
import { findRunProcesses, isSnapshotWrapper, stopTarget, unquoteWrapper } from './processMatch'

const p = (pid: number, ppid: number, pgid: number | null, command: string): ProcessInfo => ({
  pid,
  ppid,
  pgid,
  command
})

const SNAP = '/Users/a/.claude/shell-snapshots/snapshot-zsh-17.sh'
const wrapper = (cmd: string): string =>
  `/bin/zsh -c source ${SNAP} 2>/dev/null || true && setopt NO_EXTENDED_GLOB && eval '${cmd.replace(/'/g, `'"'"'`)}' \\< /dev/null && pwd -P >| /tmp/cwd`

// Tab pty 100 (claude), group 100; another tab 200.
const base = [
  p(1, 0, 1, '/sbin/launchd'),
  p(100, 1, 100, 'claude --session-id x'),
  p(150, 100, 150, 'node /mcp/server.js'),
  p(200, 1, 200, 'claude --session-id y')
]

describe('snapshot wrapper', () => {
  it('recognises the wrapper and undoes eval quoting (POSIX and Windows forms)', () => {
    expect(isSnapshotWrapper(wrapper('pnpm test'))).toBe(true)
    expect(isSnapshotWrapper('node vitest')).toBe(false)
    expect(unquoteWrapper(wrapper(`echo 'a' && pnpm test`))).toContain(
      `eval 'echo 'a' && pnpm test'`
    )
    expect(unquoteWrapper(`eval 'echo '\\"'\\"'a'\\"'\\"''`)).toBe(`eval 'echo 'a''`)
    expect(
      isSnapshotWrapper(
        'bash -c "source C:\\Users\\a\\.claude\\shell-snapshots\\snapshot-bash-1.sh && eval \'x\'"'
      )
    ).toBe(true)
  })
})

describe('findRunProcesses', () => {
  it('matches the wrapper of the run inside the tab only', () => {
    const list = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test --run')),
      p(301, 300, 300, 'node /code/node_modules/.bin/vitest --run'),
      p(400, 200, 400, wrapper('pnpm test --run'))
    ]
    const found = findRunProcesses(list, 100, {
      command: 'pnpm test --run',
      tokens: ['pnpm', 'test']
    })
    expect(found.map((x) => x.pid)).toEqual([300])
  })

  it('reports every candidate when two runs look the same', () => {
    const list = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test')),
      p(310, 100, 310, wrapper('pnpm test'))
    ]
    expect(findRunProcesses(list, 100, { command: 'pnpm test', tokens: [] })).toHaveLength(2)
  })

  it('falls back to the topmost process carrying the runner tokens', () => {
    const list = [
      ...base,
      p(300, 100, 300, '/bin/zsh -c other-wrapper'),
      p(301, 300, 300, 'node /x/node_modules/.bin/vitest run'),
      p(302, 301, 300, 'node /x/node_modules/vitest/dist/worker.js vitest')
    ]
    const found = findRunProcesses(list, 100, { command: 'npx vitest run', tokens: ['vitest'] })
    expect(found.map((x) => x.pid)).toEqual([301])
    expect(findRunProcesses(list, 100, { command: 'x', tokens: ['jest'] })).toEqual([])
    expect(findRunProcesses(list, 100, { command: 'x', tokens: [] })).toEqual([])
  })

  it('matches Windows executables by base name without extension', () => {
    const list = [
      p(10, 0, null, 'claude.exe'),
      p(
        11,
        10,
        null,
        'C:\\Program Files\\nodejs\\node.exe C:\\code\\node_modules\\jest\\bin\\jest.js'
      )
    ]
    expect(findRunProcesses(list, 10, { command: 'npx jest', tokens: ['jest'] })).toHaveLength(1)
  })
})

describe('stopTarget', () => {
  it('kills the run group, never the tab group or a foreign group', () => {
    const list = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test')),
      p(301, 300, 300, 'vitest'),
      p(302, 100, 100, 'vitest same group as claude'),
      p(303, 100, 200, 'vitest in another tab group')
    ]
    expect(stopTarget(list[4], list, 100)).toBe(300)
    expect(stopTarget(list[5], list, 100)).toBe(300)
    expect(stopTarget(list[6], list, 100)).toBeNull()
    expect(stopTarget(list[7], list, 100)).toBeNull()
    expect(stopTarget(list[1], list, 100)).toBeNull()
  })

  it('uses the pid itself on Windows', () => {
    const list = [p(10, 0, null, 'claude.exe'), p(11, 10, null, 'jest')]
    expect(stopTarget(list[1], list, 10)).toBe(11)
  })
})
