import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, AccountUsage } from '../../shared/types'
import { buildSessionEnv, claudeCommand, defaultShell } from '../env/shellEnv'
import { parseUsageCommandOutput, USAGE_COMMAND_ARGS, usageResultText } from './usageCommand'

type Env = Record<string, string>
export type Spawner = (file: string, args: string[], options: SpawnOptions) => ChildProcess

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000
/** A reading younger than this is not refreshed unless forced; also the pollSoon throttle. */
export const MIN_POLL_AGE_MS = 60_000
export const POLL_TIMEOUT_MS = 30_000
export const MAX_FAILURES = 3
export const FAILURE_BACKOFF_MS = 30 * 60_000
const KILL_GRACE_MS = 3000
const DEFAULT_JITTER_MS = 2000
const MAX_STDOUT = 1024 * 1024
const STDERR_TAIL = 300

/** Same cwd as optimize runs, so Claude keeps a single `projects/` entry for ClaudeDeck. */
export const usageWorkspace = (configDir: string): string =>
  join(configDir, 'claudedeck', 'workspace')

export interface UsagePollerDeps {
  repo: { get(): { accounts: Account[] } }
  /** The user's login shell env (resolveShellEnv). */
  baseEnv(): Promise<Env>
  claudeAvailable(): Promise<boolean>
  isSignedIn?(accountId: string): boolean | Promise<boolean>
  onUsage(usage: AccountUsage): void
  intervalMs?: number
  timeoutMs?: number
  jitterMs?: number
  spawn?: Spawner
  /** Kills the run's whole process group. */
  killTree?: (child: ChildProcess, signal: NodeJS.Signals) => void
  now?: () => number
  random?: () => number
}

export interface UsagePoller {
  /** Polls every account once, then on every interval. */
  start(): void
  /** Stops the timer, drops the queue and kills a running poll. */
  stop(): void
  /** Polls one account (or all) now, ignoring age and backoff. */
  pollNow(accountId?: string): void
  /** Polls stale accounts; throttled (meant for window focus). */
  pollSoon(): void
}

interface AccountState {
  lastAttempt: number | null
  failures: number
  retryAt: number
}

interface Job {
  accountId: string
  force: boolean
}

type Outcome = { ok: true; usage: AccountUsage } | { ok: false; reason: string }

function defaultKillTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Detached: the shell leads its own process group, so claude goes too.
    if (child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

/** Reads plan usage with `claude -p /usage` (no model call), one account at a time. */
export function createUsagePoller(deps: UsagePollerDeps): UsagePoller {
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = deps.timeoutMs ?? POLL_TIMEOUT_MS
  const jitterMs = deps.jitterMs ?? DEFAULT_JITTER_MS
  const spawnFn = deps.spawn ?? nodeSpawn
  const killTree = deps.killTree ?? defaultKillTree
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random

  const states = new Map<string, AccountState>()
  const queue: Job[] = []
  let timer: NodeJS.Timeout | null = null
  let draining = false
  let stopped = false
  let lastSoon: number | null = null
  let current: ChildProcess | null = null

  const stateOf = (accountId: string): AccountState => {
    let state = states.get(accountId)
    if (!state) {
      state = { lastAttempt: null, failures: 0, retryAt: 0 }
      states.set(accountId, state)
    }
    return state
  }

  const isDue = (job: Job): boolean => {
    if (job.force) return true
    const state = stateOf(job.accountId)
    const at = now()
    if (state.retryAt > at) return false
    return state.lastAttempt === null || at - state.lastAttempt >= MIN_POLL_AGE_MS
  }

  const enqueue = (accountId: string, force: boolean): void => {
    const queued = queue.find((j) => j.accountId === accountId)
    if (queued) queued.force ||= force
    else queue.push({ accountId, force })
  }

  const enqueueAll = (force: boolean): void => {
    const ids = deps.repo.get().accounts.map((a) => a.id)
    const known = new Set(ids)
    for (const id of states.keys()) if (!known.has(id)) states.delete(id)
    ids.forEach((id) => enqueue(id, force))
    void drain()
  }

  const wait = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

  const runOnce = async (account: Account): Promise<Outcome> => {
    const base = await deps.baseEnv()
    const workspace = usageWorkspace(account.configDir)
    mkdirSync(workspace, { recursive: true })
    return new Promise<Outcome>((resolve) => {
      let child: ChildProcess
      try {
        child = spawnFn(
          defaultShell(base),
          ['-ilc', claudeCommand(account.configDir, USAGE_COMMAND_ARGS)],
          {
            cwd: workspace,
            env: buildSessionEnv(base, account),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
          }
        )
      } catch (error) {
        resolve({ ok: false, reason: `spawn failed: ${(error as Error).message}` })
        return
      }
      current = child
      let stdout = ''
      let stderr = ''
      let settled = false
      let killTimer: NodeJS.Timeout | null = null

      const finish = (outcome: Outcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (current === child) current = null
        resolve(outcome)
      }

      const timeout = setTimeout(() => {
        killTree(child, 'SIGTERM')
        killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
        killTimer.unref?.()
        finish({ ok: false, reason: 'timed out' })
      }, timeoutMs)
      timeout.unref?.()

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < MAX_STDOUT) stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL)
      })
      child.on('error', (error) => finish({ ok: false, reason: error.message }))
      child.on('close', (code) => {
        if (killTimer) clearTimeout(killTimer)
        const text = usageResultText(stdout)
        const usage = text === null ? null : parseUsageCommandOutput(text, account.id, now())
        if (usage) {
          finish({ ok: true, usage })
          return
        }
        const why = text === null ? `no result (exit ${code ?? 'unknown'})` : 'no plan usage'
        const tail = stderr.trim()
        finish({ ok: false, reason: tail ? `${why}: ${tail}` : why })
      })
    })
  }

  const record = (accountId: string, outcome: Outcome): void => {
    // The account may have been removed while the poll ran.
    if (!deps.repo.get().accounts.some((a) => a.id === accountId)) return
    const state = stateOf(accountId)
    if (outcome.ok) {
      state.failures = 0
      state.retryAt = 0
      deps.onUsage(outcome.usage)
      return
    }
    state.failures += 1
    if (state.failures >= MAX_FAILURES) state.retryAt = now() + FAILURE_BACKOFF_MS
    console.warn('[usage] poll failed', accountId, state.failures, outcome.reason)
  }

  const drain = async (): Promise<void> => {
    if (draining || stopped) return
    draining = true
    try {
      let available: boolean | null = null
      while (!stopped && queue.length > 0) {
        const job = queue.shift() as Job
        const account = deps.repo.get().accounts.find((a) => a.id === job.accountId)
        if (!account || !isDue(job)) continue
        available ??= await deps.claudeAvailable().catch(() => false)
        if (!available) {
          queue.length = 0
          break
        }
        if (deps.isSignedIn && !(await deps.isSignedIn(account.id))) continue
        await wait(Math.floor(random() * jitterMs))
        if (stopped) break
        stateOf(account.id).lastAttempt = now()
        let outcome: Outcome
        try {
          outcome = await runOnce(account)
        } catch (error) {
          outcome = { ok: false, reason: (error as Error).message }
        }
        if (stopped) break
        record(account.id, outcome)
      }
    } catch (error) {
      console.warn('[usage] poller error', error)
    } finally {
      draining = false
    }
    // Jobs queued while the last poll finished.
    if (!stopped && queue.length > 0) void drain()
  }

  return {
    start() {
      if (stopped || timer) return
      enqueueAll(false)
      timer = setInterval(() => enqueueAll(false), intervalMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      queue.length = 0
      if (current) killTree(current, 'SIGTERM')
      current = null
    },
    pollNow(accountId) {
      if (stopped) return
      if (accountId === undefined) {
        enqueueAll(true)
        return
      }
      if (!deps.repo.get().accounts.some((a) => a.id === accountId)) return
      enqueue(accountId, true)
      void drain()
    },
    pollSoon() {
      if (stopped) return
      const at = now()
      if (lastSoon !== null && at - lastSoon < MIN_POLL_AGE_MS) return
      lastSoon = at
      enqueueAll(false)
    }
  }
}
