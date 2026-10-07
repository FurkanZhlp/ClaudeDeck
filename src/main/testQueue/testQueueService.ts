import { randomUUID } from 'node:crypto'
import { DomainError } from '../../shared/errors'
import type {
  ClassifyResult,
  Project,
  TestQueueAgentView,
  TestQueueLoad,
  TestQueueSettings,
  TestQueueSnapshot,
  TestRun
} from '../../shared/types'
import type { ClassifyOptions } from './classifier'
import type { ProcessInfo } from '../platform/processList'
import { defaultAutoMax, type SystemLoad } from '../platform/systemLoad'
import type { SessionScope } from '../mcp/sessionTokens'
import { parsePostToolUse, parsePreToolUse } from './hookPayload'
import { findRunProcesses, stopTarget } from './processMatch'

/** Fixed reasons the agent sees; never built from request data. */
export const CANCEL_REASON = 'ClaudeDeck test queue: the user cancelled this test run.'
export const MAX_WAIT_REASON =
  'ClaudeDeck test queue: queue full; run the same command again to re-queue.'

/** Hook reply without a decision: the tool call goes ahead untouched. */
export const PASS = ''

const denyReply = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
export const CANCEL_REPLY = denyReply(CANCEL_REASON)
export const MAX_WAIT_REPLY = denyReply(MAX_WAIT_REASON)

export const MAX_RUNS_PER_SESSION = 20
export const MAX_RUNS_TOTAL = 200
const MAX_COMMAND_SHOWN = 500
/** A retry within this window keeps its original place in the queue. */
export const REQUEUE_WINDOW_MS = 10 * 60 * 1000
const MAX_EXPIRED_KEPT = 200
const TICK_MS = 1000
const SAMPLE_MS = 2000
/** Process checks of a starting run, after its start. */
export const START_PROBES_MS = [10_000, 30_000, 60_000]
/** A run whose process disappeared without a PostToolUse is done after this. */
export const PROCESS_GONE_GRACE_MS = 5000
const PUSH_DEBOUNCE_MS = 500

/** Session transcript events the queue reacts to (background completion). */
export interface QueueTranscriptEvent {
  type: string
  toolUseId?: string
}

export type WatchTranscript = (
  sessionId: string,
  onEvent: (event: QueueTranscriptEvent) => void
) => (() => void) | null

export interface TestQueueDeps {
  settings(): TestQueueSettings
  project(projectId: string): Project | undefined
  classify(command: string, opts: ClassifyOptions): ClassifyResult
  fingerprint(result: ClassifyResult): string[]
  /** The tab's pty is running. */
  isLive(sessionId: string): boolean
  ptyPid(sessionId: string): number | undefined
  listProcesses(): Promise<ProcessInfo[]>
  /** Ends a process tree (POSIX: the group led by `pid`; Windows: taskkill /T). */
  killTree(pid: number): void
  load: SystemLoad
  cpuCount(): number
  /** Background completion source; null when the transcript cannot be watched. */
  watchTranscript?: WatchTranscript
  onSnapshot(snapshot: TestQueueSnapshot): void
  /** Process checks of running runs; 2 s by default (use more on Windows, CIM is slow). */
  processCheckMs?: number
  newId?: () => string
}

interface Entry {
  run: TestRun
  rawCommand: string
  tokens: string[]
  toolUseId: string
  /** Answers the waiting hook; null once answered. */
  reply: ((body: string) => void) | null
  /** Start of this wait (max wait counts from here, ordering from run.enqueuedAt). */
  waitingSince: number
  probesDone: number
  backgroundSince: number | null
  /** Pid of the matched process tree, once seen. */
  pid: number | null
  pidGoneAt: number | null
}

interface Expired {
  sessionId: string
  command: string
  enqueuedAt: number
  at: number
}

const ACTIVE = new Set<TestRun['state']>(['starting', 'running', 'background'])
const isActive = (e: Entry): boolean => ACTIVE.has(e.run.state)
const isQueued = (e: Entry): boolean => e.run.state === 'queued'

export interface TestQueueService {
  /** PreToolUse: resolves with the hook's stdout once the command may run (or is denied). */
  pre(scope: SessionScope, payload: unknown, signal: AbortSignal): Promise<string>
  /** PostToolUse / PostToolUseFailure. */
  post(scope: SessionScope, payload: unknown): void
  snapshot(): TestQueueSnapshot
  cancel(runId: string): TestQueueSnapshot
  move(runId: string, position: number): TestQueueSnapshot
  runNow(runId: string): TestQueueSnapshot
  release(runId: string): TestQueueSnapshot
  stop(runId: string): Promise<TestQueueSnapshot>
  /** What a tab sees through MCP. */
  agentView(scope: SessionScope): TestQueueAgentView
  /** MCP cancel: only runs of the caller's own tab (and its subagents). */
  cancelOwn(scope: SessionScope, runId: string): Promise<'cancelled' | 'stopped'>
  /** Last hook request per account (epoch ms). */
  lastCallAt(accountId: string): number | null
  /** Run a subagent of a tab is waiting on or running (agent viewer badge). */
  runIdForAgent(sessionId: string, agentId: string): string | undefined
  /** Pty exit, token revoke: the tab's runs end and its waiters are answered. */
  dropSession(sessionId: string): void
  /** Renderer reload or all tabs killed. */
  dropAll(): void
  settingsChanged(): void
  dispose(): void
}

export function createTestQueueService(deps: TestQueueDeps): TestQueueService {
  const newId = deps.newId ?? randomUUID
  const processCheckMs = deps.processCheckMs ?? 2000
  const entries = new Map<string, Entry>()
  /** Queue order of waiting runs (ids). */
  const order: string[] = []
  const expired: Expired[] = []
  const lastCalls = new Map<string, number>()
  const transcriptWatches = new Map<string, () => void>()
  let lastStartAt = 0
  let lastSampleAt = 0
  let lastProcessCheckAt = 0
  let sampling = false
  let checking = false
  let ticker: NodeJS.Timeout | null = null
  let pushTimer: NodeJS.Timeout | null = null
  let disposed = false

  const settings = (): TestQueueSettings => deps.settings()

  const limit = (s: TestQueueSettings = settings()): number =>
    s.mode === 'fixed' ? s.maxConcurrent : (s.auto.maxConcurrent ?? defaultAutoMax(deps.cpuCount()))

  const currentLoad = (s: TestQueueSettings = settings()): TestQueueLoad | null =>
    s.mode === 'auto' ? deps.load.current() : null

  const runsInOrder = (): TestRun[] => {
    const active = [...entries.values()]
      .filter(isActive)
      .sort((a, b) => (a.run.startedAt ?? 0) - (b.run.startedAt ?? 0))
    const queued = order.map((id) => entries.get(id)).filter((e): e is Entry => !!e)
    return [...active, ...queued].map((e) => ({ ...e.run }))
  }

  const snapshot = (): TestQueueSnapshot => {
    const s = settings()
    return {
      enabled: s.enabled,
      mode: s.mode,
      limit: limit(s),
      runs: runsInOrder(),
      load: currentLoad(s),
      updatedAt: Date.now()
    }
  }

  const push = (): void => {
    if (pushTimer || disposed) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (!disposed) deps.onSnapshot(snapshot())
    }, PUSH_DEBOUNCE_MS)
  }

  const unwatchIfIdle = (sessionId: string): void => {
    const stillBackground = [...entries.values()].some(
      (e) => e.run.sessionId === sessionId && e.run.state === 'background'
    )
    if (stillBackground) return
    transcriptWatches.get(sessionId)?.()
    transcriptWatches.delete(sessionId)
  }

  /** Removes an entry; a waiting hook gets `reply` (pass-through unless given). */
  const finish = (entry: Entry, state: TestRun['state'], reply: string = PASS): void => {
    if (!entries.has(entry.run.id)) return
    entries.delete(entry.run.id)
    const index = order.indexOf(entry.run.id)
    if (index >= 0) order.splice(index, 1)
    entry.run.state = state
    entry.run.finishedAt = Date.now()
    const answer = entry.reply
    entry.reply = null
    answer?.(reply)
    if (state === 'expired') {
      expired.push({
        sessionId: entry.run.sessionId,
        command: entry.rawCommand,
        enqueuedAt: entry.run.enqueuedAt,
        at: Date.now()
      })
      if (expired.length > MAX_EXPIRED_KEPT) expired.shift()
    }
    unwatchIfIdle(entry.run.sessionId)
    push()
    if (entries.size === 0) stopTicker()
    else admit()
  }

  const start = (entry: Entry, forced: boolean): void => {
    const index = order.indexOf(entry.run.id)
    if (index >= 0) order.splice(index, 1)
    const now = Date.now()
    entry.run.state = 'starting'
    entry.run.startedAt = now
    entry.run.forced = entry.run.forced || forced
    lastStartAt = now
    const answer = entry.reply
    entry.reply = null
    answer?.(PASS)
    push()
  }

  const activeCount = (): number => [...entries.values()].filter(isActive).length

  /** Starts what capacity allows: fixed fills up, auto starts at most one per call. */
  const admit = (): void => {
    if (disposed) return
    const s = settings()
    const head = (): Entry | undefined => {
      for (const id of order) {
        const entry = entries.get(id)
        if (entry) return entry
      }
      return undefined
    }
    if (s.mode === 'fixed') {
      let next = head()
      while (next && activeCount() < s.maxConcurrent) {
        start(next, false)
        next = head()
      }
      return
    }
    const next = head()
    if (!next) return
    const active = activeCount()
    if (active === 0) return start(next, false)
    if (active >= limit(s)) return
    const load = deps.load.current()
    if (!load || load.saturated || load.lowMemory) return
    if (Date.now() - lastStartAt < s.auto.rampUpSeconds * 1000) return
    start(next, false)
  }

  const sample = async (): Promise<void> => {
    if (sampling) return
    sampling = true
    try {
      const { auto } = settings()
      await deps.load.sample(auto)
    } catch (error) {
      console.warn('[test-queue] load sample failed', error)
    } finally {
      sampling = false
    }
    push()
    admit()
  }

  /** Process discovery for active runs: evidence for starting ones, liveness and canStop. */
  const checkProcesses = async (): Promise<void> => {
    if (checking) return
    checking = true
    let list: ProcessInfo[] | null = null
    try {
      list = await deps.listProcesses()
    } catch (error) {
      console.warn('[test-queue] process list failed', error)
    } finally {
      checking = false
    }
    if (!list || disposed) return
    const now = Date.now()
    for (const entry of [...entries.values()]) {
      if (!isActive(entry) || !entries.has(entry.run.id)) continue
      const root = deps.ptyPid(entry.run.sessionId)
      if (root === undefined) continue
      const matches = findRunProcesses(list, root, {
        command: entry.rawCommand,
        tokens: entry.tokens
      })
      const canStop = matches.length === 1 && stopTarget(matches[0], list, root) !== null
      if (canStop !== entry.run.canStop) {
        entry.run.canStop = canStop
        push()
      }
      if (matches.length > 0) {
        entry.pid = matches[0].pid
        entry.pidGoneAt = null
        if (entry.run.state === 'starting') {
          entry.run.state = 'running'
          push()
        }
        continue
      }
      if (entry.pid === null) continue
      entry.pidGoneAt ??= now
      if (now - entry.pidGoneAt >= PROCESS_GONE_GRACE_MS) finish(entry, 'done')
    }
  }

  const tick = (): void => {
    if (disposed) return
    const s = settings()
    const now = Date.now()
    let probe = false
    for (const entry of [...entries.values()]) {
      const { run } = entry
      if (run.state === 'queued') {
        if (now - entry.waitingSince >= s.maxWaitMinutes * 60_000) {
          finish(entry, 'expired', MAX_WAIT_REPLY)
        }
        continue
      }
      if (run.state === 'starting') {
        const elapsed = now - (run.startedAt ?? now)
        if (elapsed >= s.startGraceSeconds * 1000) {
          finish(entry, 'done')
          continue
        }
        while (
          entry.probesDone < START_PROBES_MS.length &&
          elapsed >= START_PROBES_MS[entry.probesDone]
        ) {
          entry.probesDone += 1
          probe = true
        }
        continue
      }
      if (
        run.state === 'background' &&
        entry.pid === null &&
        entry.backgroundSince !== null &&
        now - entry.backgroundSince >= s.backgroundMaxHoldMinutes * 60_000
      ) {
        finish(entry, 'done')
      }
    }
    const watched = [...entries.values()].some(
      (e) => e.run.state === 'running' || e.run.state === 'background'
    )
    if (probe || (watched && now - lastProcessCheckAt >= processCheckMs)) {
      lastProcessCheckAt = now
      void checkProcesses()
    }
    if (s.mode === 'auto' && entries.size > 0 && now - lastSampleAt >= SAMPLE_MS) {
      lastSampleAt = now
      void sample()
    } else {
      admit()
    }
  }

  const startTicker = (): void => {
    if (ticker || disposed) return
    ticker = setInterval(tick, TICK_MS)
    ticker.unref?.()
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
    // Sampling only runs while entries exist; the next burst starts from fresh history.
    deps.load.reset()
    lastSampleAt = 0
  }

  const entryOf = (runId: unknown): Entry => {
    const entry = typeof runId === 'string' ? entries.get(runId) : undefined
    if (!entry) throw new DomainError('NOT_FOUND')
    return entry
  }

  /** Place of a retried run: before the first waiting run that was enqueued after it. */
  const insert = (entry: Entry): void => {
    const at = order.findIndex(
      (id) => (entries.get(id)?.run.enqueuedAt ?? 0) > entry.run.enqueuedAt
    )
    if (at < 0) order.push(entry.run.id)
    else order.splice(at, 0, entry.run.id)
  }

  const originalEnqueue = (sessionId: string, command: string, now: number): number | null => {
    for (let i = expired.length - 1; i >= 0; i--) {
      const e = expired[i]
      if (now - e.at > REQUEUE_WINDOW_MS) continue
      if (e.sessionId !== sessionId || e.command !== command) continue
      expired.splice(i, 1)
      return e.enqueuedAt
    }
    return null
  }

  const watchBackground = (sessionId: string): void => {
    if (transcriptWatches.has(sessionId) || !deps.watchTranscript) return
    try {
      const stop = deps.watchTranscript(sessionId, (event) => {
        if (event.type !== 'taskNotification' || !event.toolUseId) return
        for (const entry of [...entries.values()]) {
          if (
            entry.run.sessionId === sessionId &&
            entry.run.state === 'background' &&
            entry.toolUseId === event.toolUseId
          ) {
            finish(entry, 'done')
          }
        }
      })
      if (stop) transcriptWatches.set(sessionId, stop)
    } catch (error) {
      console.warn('[test-queue] could not watch the transcript', error)
    }
  }

  const killRun = async (entry: Entry): Promise<void> => {
    const root = deps.ptyPid(entry.run.sessionId)
    if (root === undefined) throw new DomainError('INVALID')
    const list = await deps.listProcesses()
    const matches = findRunProcesses(list, root, {
      command: entry.rawCommand,
      tokens: entry.tokens
    })
    const target = matches.length === 1 ? stopTarget(matches[0], list, root) : null
    if (target === null) {
      entry.run.canStop = false
      push()
      throw new DomainError('INVALID')
    }
    deps.killTree(target)
  }

  return {
    pre(scope, payload, signal) {
      lastCalls.set(scope.accountId, Date.now())
      const s = settings()
      if (disposed || !s.enabled || signal.aborted) return Promise.resolve(PASS)
      const pre = parsePreToolUse(payload)
      if (!pre) return Promise.resolve(PASS)
      const project = deps.project(scope.projectId)
      if (!project) return Promise.resolve(PASS)
      const result = deps.classify(pre.command, {
        disabledBuiltins: s.disabledBuiltins,
        customPatterns: s.customPatterns,
        projectOverrides: project.testQueue
      })
      if (!result.isTest || !result.ruleId) return Promise.resolve(PASS)

      const all = [...entries.values()]
      const perSession = all.filter((e) => e.run.sessionId === scope.sessionId).length
      if (all.length >= MAX_RUNS_TOTAL || perSession >= MAX_RUNS_PER_SESSION) {
        return Promise.resolve(PASS)
      }
      // A repeated hook call for the same tool use replaces the earlier one.
      for (const e of all) {
        if (e.run.sessionId === scope.sessionId && e.toolUseId === pre.toolUseId) {
          finish(e, isQueued(e) ? 'abandoned' : 'done')
        }
      }

      const now = Date.now()
      const entry: Entry = {
        run: {
          id: newId(),
          sessionId: scope.sessionId,
          projectId: scope.projectId,
          accountId: scope.accountId,
          ...(pre.agentId ? { agentId: pre.agentId } : {}),
          ...(pre.agentType ? { agentType: pre.agentType } : {}),
          command: pre.command.slice(0, MAX_COMMAND_SHOWN),
          ruleId: result.ruleId,
          state: 'queued',
          enqueuedAt: originalEnqueue(scope.sessionId, pre.command, now) ?? now,
          forced: false,
          canStop: false
        },
        rawCommand: pre.command,
        tokens: deps.fingerprint(result),
        toolUseId: pre.toolUseId,
        reply: null,
        waitingSince: now,
        probesDone: 0,
        backgroundSince: null,
        pid: null,
        pidGoneAt: null
      }
      return new Promise<string>((resolve) => {
        entry.reply = resolve
        entries.set(entry.run.id, entry)
        insert(entry)
        signal.addEventListener(
          'abort',
          () => {
            // Esc, a killed hook or a closed tab: the waiter is gone.
            if (entries.get(entry.run.id) === entry && isQueued(entry)) finish(entry, 'abandoned')
          },
          { once: true }
        )
        startTicker()
        push()
        admit()
      })
    },

    post(scope, payload) {
      lastCalls.set(scope.accountId, Date.now())
      const post = parsePostToolUse(payload)
      if (!post) return
      for (const entry of [...entries.values()]) {
        if (entry.run.sessionId !== scope.sessionId || entry.toolUseId !== post.toolUseId) continue
        if (!isActive(entry)) continue
        if (post.background) {
          entry.run.state = 'background'
          entry.backgroundSince = Date.now()
          watchBackground(scope.sessionId)
          push()
        } else {
          finish(entry, 'done')
        }
      }
    },

    snapshot,

    cancel(runId) {
      const entry = entryOf(runId)
      if (!isQueued(entry)) throw new DomainError('INVALID')
      finish(entry, 'cancelled', CANCEL_REPLY)
      return snapshot()
    },

    move(runId, position) {
      const entry = entryOf(runId)
      if (!isQueued(entry) || !Number.isInteger(position) || position < 0) {
        throw new DomainError('INVALID')
      }
      order.splice(order.indexOf(entry.run.id), 1)
      order.splice(Math.min(position, order.length), 0, entry.run.id)
      push()
      admit()
      return snapshot()
    },

    runNow(runId) {
      const entry = entryOf(runId)
      if (!isQueued(entry)) throw new DomainError('INVALID')
      start(entry, true)
      return snapshot()
    },

    release(runId) {
      const entry = entryOf(runId)
      if (!isActive(entry)) throw new DomainError('INVALID')
      finish(entry, 'done')
      return snapshot()
    },

    async stop(runId) {
      const entry = entryOf(runId)
      if (!isActive(entry)) throw new DomainError('INVALID')
      await killRun(entry)
      return snapshot()
    },

    agentView(scope) {
      const s = settings()
      const runs = runsInOrder()
      const others = runs.filter((r) => r.accountId !== scope.accountId)
      return {
        mode: s.mode,
        limit: limit(s),
        load: currentLoad(s),
        runs: runs.filter((r) => r.accountId === scope.accountId),
        otherAccountsRunning: others.filter((r) => ACTIVE.has(r.state)).length,
        otherAccountsWaiting: others.filter((r) => r.state === 'queued').length
      }
    },

    async cancelOwn(scope, runId) {
      const entry = typeof runId === 'string' ? entries.get(runId) : undefined
      if (!entry || entry.run.sessionId !== scope.sessionId) throw new DomainError('NOT_FOUND')
      if (isQueued(entry)) {
        finish(entry, 'cancelled', CANCEL_REPLY)
        return 'cancelled'
      }
      await killRun(entry)
      return 'stopped'
    },

    lastCallAt: (accountId) => lastCalls.get(accountId) ?? null,

    runIdForAgent(sessionId, agentId) {
      for (const entry of entries.values()) {
        if (entry.run.sessionId === sessionId && entry.run.agentId === agentId) return entry.run.id
      }
      return undefined
    },

    dropSession(sessionId) {
      for (const entry of [...entries.values()]) {
        if (entry.run.sessionId === sessionId) finish(entry, isQueued(entry) ? 'abandoned' : 'done')
      }
      transcriptWatches.get(sessionId)?.()
      transcriptWatches.delete(sessionId)
    },

    dropAll() {
      for (const entry of [...entries.values()]) {
        finish(entry, isQueued(entry) ? 'abandoned' : 'done')
      }
      for (const stop of transcriptWatches.values()) stop()
      transcriptWatches.clear()
    },

    settingsChanged() {
      const s = settings()
      if (!s.enabled) {
        // Turned off: nobody waits any more and no slot is held.
        for (const entry of [...entries.values()]) {
          finish(entry, isQueued(entry) ? 'abandoned' : 'done')
        }
      }
      push()
      admit()
    },

    dispose() {
      for (const entry of [...entries.values()]) {
        const answer = entry.reply
        entry.reply = null
        answer?.(PASS)
      }
      entries.clear()
      order.length = 0
      for (const stop of transcriptWatches.values()) stop()
      transcriptWatches.clear()
      disposed = true
      if (ticker) clearInterval(ticker)
      ticker = null
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = null
    }
  }
}
