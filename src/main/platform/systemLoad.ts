import { execFile } from 'node:child_process'
import * as nodeOs from 'node:os'
import type { TestQueueLoad } from '../../shared/types'
import type { OsName } from './types'

/** Smoothing factor of the exponential moving average. */
export const LOAD_EMA_ALPHA = 0.35
/** Samples above the CPU threshold in a row before the system counts as saturated. */
export const SATURATION_SAMPLES = 2
/** Memory hysteresis: low memory clears this many points above the floor. */
export const MEMORY_BAND_PERCENT = 5

const SYSCTL = '/usr/sbin/sysctl'
const VM_STAT = '/usr/bin/vm_stat'
const EXEC_TIMEOUT_MS = 2000

export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

/** OS access of the sampler; tests pass fakes. */
export interface SystemLoadDeps {
  os: OsName
  cpus: () => { times: CpuTimes }[]
  loadavg: () => number[]
  freemem: () => number
  totalmem: () => number
  /** Runs a fixed executable with fixed arguments; resolves stdout. */
  run: (file: string, args: string[]) => Promise<string>
}

export interface LoadThresholds {
  cpuHighPercent: number
  cpuResumePercent: number
  minAvailableMemoryPercent: number
}

export interface SystemLoad {
  /** Takes one sample, updates the smoothed values and the hysteresis state. */
  sample(thresholds: LoadThresholds): Promise<TestQueueLoad>
  /** Last result, null before the first sample or after reset. */
  current(): TestQueueLoad | null
  /** Forgets the history (sampling paused while the queue is empty). */
  reset(): void
}

const runFile = (file: string, args: string[]): Promise<string> =>
  new Promise((done, fail) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? fail(error) : done(String(stdout))
    )
  })

export const nodeSystemLoadDeps = (os: OsName = process.platform): SystemLoadDeps => ({
  os,
  cpus: () => nodeOs.cpus(),
  loadavg: () => nodeOs.loadavg(),
  freemem: () => nodeOs.freemem(),
  totalmem: () => nodeOs.totalmem(),
  run: runFile
})

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Total and idle time summed over all cores. */
export function cpuTotals(cpus: { times: CpuTimes }[]): { total: number; idle: number } {
  let total = 0
  let idle = 0
  for (const { times } of cpus) {
    total += times.user + times.nice + times.sys + times.idle + times.irq
    idle += times.idle
  }
  return { total, idle }
}

/** Busy share (0..1) between two cpuTotals readings; null when no time passed. */
export function busyBetween(
  prev: { total: number; idle: number },
  next: { total: number; idle: number }
): number | null {
  const total = next.total - prev.total
  if (total <= 0) return null
  return clamp01(1 - (next.idle - prev.idle) / total)
}

/** `sysctl -n kern.memorystatus_level`: available memory percentage, or null. */
export function parseMemorystatusLevel(text: string): number | null {
  const value = Number(text.trim())
  return Number.isFinite(value) && value >= 0 && value <= 100 && text.trim() !== '' ? value : null
}

/**
 * `vm_stat` output: free + inactive + purgeable + speculative pages as a percentage of
 * `totalBytes`; null when the page size or the free count is missing.
 */
export function parseVmStat(text: string, totalBytes: number): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text)
  if (!pageSize || totalBytes <= 0) return null
  const pages = (name: string): number | null => {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return match ? Number(match[1]) : null
  }
  const free = pages('free')
  if (free === null) return null
  const available =
    free + (pages('inactive') ?? 0) + (pages('purgeable') ?? 0) + (pages('speculative') ?? 0)
  return Math.min(100, (available * Number(pageSize[1]) * 100) / totalBytes)
}

/**
 * Available memory percentage. macOS: the kernel's memory pressure level (os.freemem only counts
 * free pages and reads near zero on a healthy Mac), vm_stat as fallback. Elsewhere freemem.
 */
export async function availableMemoryPercent(deps: SystemLoadDeps): Promise<number> {
  const total = deps.totalmem()
  if (deps.os === 'darwin') {
    try {
      const level = parseMemorystatusLevel(
        await deps.run(SYSCTL, ['-n', 'kern.memorystatus_level'])
      )
      if (level !== null) return level
    } catch {
      // Fall through to vm_stat.
    }
    try {
      const fromVmStat = parseVmStat(await deps.run(VM_STAT, []), total)
      if (fromVmStat !== null) return fromVmStat
    } catch {
      // Fall through to freemem.
    }
  }
  return total > 0 ? Math.min(100, (deps.freemem() * 100) / total) : 100
}

const ema = (prev: number | null, value: number): number =>
  prev === null ? value : prev + LOAD_EMA_ALPHA * (value - prev)

const round1 = (v: number): number => Math.round(v * 10) / 10

/**
 * CPU and memory sampler for the queue's automatic mode. CPU busy comes from os.cpus() time
 * deltas; on POSIX the 1 minute load average per core also counts (effective = max). Values are
 * smoothed (EMA) and saturation uses hysteresis so a single spike does not stop admissions.
 */
export function createSystemLoad(
  deps: SystemLoadDeps = nodeSystemLoadDeps(),
  now: () => number = Date.now
): SystemLoad {
  let prevCpu: { total: number; idle: number } | null = null
  let cpu: number | null = null
  let memory: number | null = null
  let above = 0
  let saturated = false
  let lowMemory = false
  let last: TestQueueLoad | null = null

  return {
    async sample(t) {
      const cpus = deps.cpus()
      const totals = cpuTotals(cpus)
      // The first reading compares against boot: the average since then, better than nothing.
      const busy = busyBetween(prevCpu ?? { total: 0, idle: 0 }, totals)
      prevCpu = totals
      let effective = busy ?? 0
      if (deps.os !== 'win32' && cpus.length > 0) {
        const perCore = clamp01((deps.loadavg()[0] ?? 0) / cpus.length)
        effective = Math.max(effective, perCore)
      }
      cpu = ema(cpu, effective * 100)
      memory = ema(memory, await availableMemoryPercent(deps))

      if (cpu > t.cpuHighPercent) above += 1
      else above = 0
      if (!saturated && above >= SATURATION_SAMPLES) saturated = true
      else if (saturated && cpu < t.cpuResumePercent) saturated = false

      if (!lowMemory && memory < t.minAvailableMemoryPercent) lowMemory = true
      else if (lowMemory && memory >= t.minAvailableMemoryPercent + MEMORY_BAND_PERCENT) {
        lowMemory = false
      }

      last = {
        cpuPercent: round1(cpu),
        availableMemoryPercent: round1(memory),
        saturated,
        lowMemory,
        sampledAt: now()
      }
      return last
    },
    current: () => last,
    reset() {
      prevCpu = null
      cpu = null
      memory = null
      above = 0
      saturated = false
      lowMemory = false
      last = null
    }
  }
}

/** Default automatic upper limit: a quarter of the cores, at least 2 and at most 6. */
export const defaultAutoMax = (cpuCount: number): number =>
  Math.min(6, Math.max(2, Math.floor(cpuCount / 4)))
