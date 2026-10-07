import { describe, expect, it } from 'vitest'
import {
  availableMemoryPercent,
  busyBetween,
  createSystemLoad,
  defaultAutoMax,
  parseMemorystatusLevel,
  parseVmStat,
  type CpuTimes,
  type SystemLoadDeps
} from './systemLoad'
import type { OsName } from './types'

const GB = 1024 ** 3
const thresholds = { cpuHighPercent: 85, cpuResumePercent: 65, minAvailableMemoryPercent: 15 }

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         80000.
Pages purgeable:                           1000.
`

/** A fake host whose cores report `busy` (0..1) of each 1000 ms step. */
function fakeHost(opts: {
  os: OsName
  cores?: number
  load1?: number
  memory?: () => Promise<string>
  freePercent?: number
}): SystemLoadDeps & { step(busy: number): void; runs: string[][] } {
  const cores = opts.cores ?? 4
  const times: CpuTimes[] = Array.from({ length: cores }, () => ({
    user: 0,
    nice: 0,
    sys: 0,
    idle: 0,
    irq: 0
  }))
  const runs: string[][] = []
  return {
    os: opts.os,
    cpus: () => times.map((t) => ({ times: { ...t } })),
    loadavg: () => [opts.load1 ?? 0, 0, 0],
    freemem: () => ((opts.freePercent ?? 50) / 100) * 16 * GB,
    totalmem: () => 16 * GB,
    run: (file, args) => {
      runs.push([file, ...args])
      return opts.memory ? opts.memory() : Promise.reject(new Error('no'))
    },
    step(busy) {
      for (const t of times) {
        t.user += busy * 1000
        t.idle += (1 - busy) * 1000
      }
    },
    runs
  }
}

describe('cpu and memory readings', () => {
  it('computes the busy share between two readings', () => {
    expect(busyBetween({ total: 1000, idle: 500 }, { total: 2000, idle: 750 })).toBe(0.75)
    expect(busyBetween({ total: 1000, idle: 500 }, { total: 1000, idle: 500 })).toBeNull()
  })

  it('parses kern.memorystatus_level and vm_stat', () => {
    expect(parseMemorystatusLevel('42\n')).toBe(42)
    expect(parseMemorystatusLevel('')).toBeNull()
    expect(parseMemorystatusLevel('abc')).toBeNull()
    expect(parseMemorystatusLevel('140')).toBeNull()
    // (10000 + 50000 + 1000 + 5000) * 16384 bytes of 16 GB
    expect(parseVmStat(VM_STAT, 16 * GB)).toBeCloseTo((66000 * 16384 * 100) / (16 * GB), 5)
    expect(parseVmStat('garbage', 16 * GB)).toBeNull()
  })

  it('reads macOS memory from sysctl, then vm_stat, never freemem first', async () => {
    const sysctl = fakeHost({ os: 'darwin', memory: () => Promise.resolve('37\n') })
    expect(await availableMemoryPercent(sysctl)).toBe(37)
    expect(sysctl.runs[0]).toEqual(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_level'])

    let call = 0
    const vmStat = fakeHost({
      os: 'darwin',
      memory: () => (call++ === 0 ? Promise.reject(new Error('x')) : Promise.resolve(VM_STAT))
    })
    expect(await availableMemoryPercent(vmStat)).toBeCloseTo((66000 * 16384 * 100) / (16 * GB), 5)
    expect(vmStat.runs[1]).toEqual(['/usr/bin/vm_stat'])
  })

  it('uses freemem on Windows without running anything', async () => {
    const host = fakeHost({ os: 'win32', freePercent: 30 })
    expect(await availableMemoryPercent(host)).toBeCloseTo(30)
    expect(host.runs).toEqual([])
  })

  it('defaults the automatic limit to a quarter of the cores within 2..6', () => {
    expect(defaultAutoMax(4)).toBe(2)
    expect(defaultAutoMax(12)).toBe(3)
    expect(defaultAutoMax(64)).toBe(6)
  })
})

describe('createSystemLoad', () => {
  it('smooths CPU with an EMA and saturates after two high samples', async () => {
    const host = fakeHost({ os: 'win32' })
    const load = createSystemLoad(host, () => 5)
    host.step(0.95)
    let s = await load.sample(thresholds)
    expect(s.cpuPercent).toBe(95)
    expect(s.saturated).toBe(false)
    host.step(0.95)
    s = await load.sample(thresholds)
    expect(s.saturated).toBe(true)
    expect(s.sampledAt).toBe(5)

    // Hysteresis: dropping to about 83 % is not enough, below 65 % clears it.
    host.step(0.6)
    s = await load.sample(thresholds)
    expect(s.cpuPercent).toBeLessThan(85)
    expect(s.saturated).toBe(true)
    for (let i = 0; i < 5; i++) {
      host.step(0.1)
      s = await load.sample(thresholds)
    }
    expect(s.cpuPercent).toBeLessThan(65)
    expect(s.saturated).toBe(false)
  })

  it('counts the load average per core on POSIX', async () => {
    const host = fakeHost({ os: 'darwin', cores: 4, load1: 4, memory: () => Promise.resolve('80') })
    const load = createSystemLoad(host)
    host.step(0.1)
    expect((await load.sample(thresholds)).cpuPercent).toBe(100)
  })

  it('keeps low memory until it is 5 points above the floor', async () => {
    let level = 10
    const host = fakeHost({ os: 'darwin', memory: () => Promise.resolve(String(level)) })
    const load = createSystemLoad(host)
    host.step(0)
    expect((await load.sample(thresholds)).lowMemory).toBe(true)
    level = 17
    for (let i = 0; i < 6; i++) await load.sample(thresholds)
    expect(load.current()?.lowMemory).toBe(true)
    level = 30
    for (let i = 0; i < 6; i++) await load.sample(thresholds)
    expect(load.current()?.lowMemory).toBe(false)
  })

  it('forgets its history on reset', async () => {
    const host = fakeHost({ os: 'win32' })
    const load = createSystemLoad(host)
    host.step(0.5)
    await load.sample(thresholds)
    load.reset()
    expect(load.current()).toBeNull()
  })
})
