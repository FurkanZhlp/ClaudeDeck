import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../platform/processList'
import {
  findRunProcesses,
  isSnapshotWrapper,
  stopTarget,
  unquoteWrapper,
  type RunMatch
} from './processMatch'

/** Runs in these tests were let through at T; their processes started a second later. */
const T = 1_000_000
const p = (
  pid: number,
  ppid: number,
  pgid: number | null,
  command: string,
  startMs: number | null = T + 1000
): ProcessInfo => ({ pid, ppid, pgid, startMs, command })
const pids = (list: ProcessInfo[]): number[] => list.map((x) => x.pid)

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
    expect(found.kind).toBe('wrapper')
    expect(pids(found.processes)).toEqual([300])
  })

  it('reports every candidate when two runs look the same', () => {
    const list = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test')),
      p(310, 100, 310, wrapper('pnpm test'))
    ]
    expect(
      findRunProcesses(list, 100, { command: 'pnpm test', tokens: [] }).processes
    ).toHaveLength(2)
  })

  it('needs the whole eval argument, closing quote included', () => {
    const list = [...base, p(300, 100, 300, wrapper('pnpm test:e2e'))]
    const found = findRunProcesses(list, 100, { command: 'pnpm test', tokens: [] })
    expect(found.processes).toEqual([])
    expect(
      pids(findRunProcesses(list, 100, { command: 'pnpm test:e2e ', tokens: [] }).processes)
    ).toEqual([300])
  })

  it('falls back to the topmost process carrying the runner tokens', () => {
    const list = [
      ...base,
      p(300, 100, 300, '/bin/zsh -c other-wrapper'),
      p(301, 300, 300, 'node /x/node_modules/.bin/vitest run'),
      p(302, 301, 300, 'node /x/node_modules/vitest/dist/worker.js vitest')
    ]
    const found = findRunProcesses(list, 100, { command: 'npx vitest run', tokens: ['vitest'] })
    expect(found.kind).toBe('tokens')
    expect(pids(found.processes)).toEqual([301])
    expect(findRunProcesses(list, 100, { command: 'x', tokens: ['jest'] }).processes).toEqual([])
    expect(findRunProcesses(list, 100, { command: 'x', tokens: [] }).processes).toEqual([])
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
    expect(
      findRunProcesses(list, 10, { command: 'npx jest', tokens: ['jest'] }).processes
    ).toHaveLength(1)
  })
})

describe('stopTarget', () => {
  const run = (list: ProcessInfo[], command: string, tokens: string[] = []): RunMatch =>
    findRunProcesses(list, 100, { command, tokens })
  const one = (kind: 'wrapper' | 'tokens', proc: ProcessInfo): RunMatch => ({
    kind,
    processes: [proc]
  })

  it('kills the run group, never the tab group or a foreign group', () => {
    const list = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test')),
      p(301, 300, 300, 'vitest'),
      p(302, 100, 100, 'vitest same group as claude'),
      p(303, 100, 200, 'vitest in another tab group')
    ]
    expect(stopTarget(run(list, 'pnpm test'), list, 100, T)).toEqual({
      pid: 300,
      command: wrapper('pnpm test'),
      startMs: T + 1000
    })
    expect(stopTarget(one('wrapper', list[5]), list, 100, T)?.pid).toBe(300)
    expect(stopTarget(one('wrapper', list[6]), list, 100, T)).toBeNull()
    expect(stopTarget(one('wrapper', list[7]), list, 100, T)).toBeNull()
    expect(stopTarget(one('wrapper', list[1]), list, 100, T)).toBeNull()
  })

  it('never stops on POSIX without a wrapper match or with several matches', () => {
    const list = [...base, p(300, 100, 300, '/bin/zsh -c x'), p(301, 300, 300, 'vitest run')]
    const byTokens = run(list, 'npx vitest run', ['vitest'])
    expect(byTokens.kind).toBe('tokens')
    expect(stopTarget(byTokens, list, 100, T)).toBeNull()
    const twice = [
      ...base,
      p(300, 100, 300, wrapper('pnpm test')),
      p(310, 100, 310, wrapper('pnpm test'))
    ]
    expect(stopTarget(run(twice, 'pnpm test'), twice, 100, T)).toBeNull()
  })

  it('requires the group leader to have started after the run (no older or reused pid)', () => {
    const older = [...base, p(300, 100, 300, wrapper('pnpm test'), T - 5000)]
    expect(stopTarget(run(older, 'pnpm test'), older, 100, T)).toBeNull()
    const sameSecond = [...base, p(300, 100, 300, wrapper('pnpm test'), T - 400)]
    expect(stopTarget(run(sameSecond, 'pnpm test'), sameSecond, 100, T)?.pid).toBe(300)
    const unknown = [...base, p(300, 100, 300, wrapper('pnpm test'), null)]
    expect(stopTarget(run(unknown, 'pnpm test'), unknown, 100, T)).toBeNull()
  })

  it('on Windows uses the pid itself, never claude or its non-wrapper children', () => {
    const claude = p(10, 0, null, 'claude.exe')
    const mcp = p(11, 10, null, 'node mcp-server.js jest')
    const bash = p(
      12,
      10,
      null,
      'bash -c "source C:/u/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'jest\'"'
    )
    const jest = p(13, 12, null, 'node jest.js')
    const list = [claude, mcp, bash, jest]
    expect(stopTarget(one('tokens', jest), list, 10, T)?.pid).toBe(13)
    expect(stopTarget(one('wrapper', bash), list, 10, T)?.pid).toBe(12)
    expect(stopTarget(one('tokens', mcp), list, 10, T)).toBeNull()
    expect(stopTarget(one('tokens', claude), list, 10, T)).toBeNull()
    const old = { ...jest, startMs: T - 60_000 }
    expect(stopTarget(one('tokens', old), [claude, bash, old], 10, T)).toBeNull()
  })
})
