import type { GuardDecision } from '../../shared/types'
import { evaluateGuard, type GuardContext } from './evaluate'

/**
 * Runs the evaluator off the main thread with a hard time limit. The evaluator is pure and
 * linear in its input, but a check that still takes too long (a pathological command, a bug)
 * must not freeze the app or let the call through: it is denied, and the worker is replaced.
 */

/** Longest a single check may take before it is denied and the worker restarted. */
export const GUARD_TIMEOUT_MS = 1500
/** Checks waiting at once; more are denied at once (the hook would time out anyway). */
export const MAX_PENDING = 256

export interface GuardRequest {
  id: number
  tool: string
  input: unknown
  ctx: GuardContext
}

export type GuardReply = { id: number; decision: GuardDecision } | { id: number; error: string }

/** The part of `worker_threads.Worker` the runner uses (tests pass fakes). */
export interface WorkerLike {
  postMessage(message: GuardRequest): void
  on(event: 'message', listener: (reply: GuardReply) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
  unref?(): void
}

export interface GuardRunner {
  evaluate(tool: string, input: unknown, ctx: GuardContext): Promise<GuardDecision>
  stop(): void
}

/** What the worker answers: the evaluator's decision or the error it threw. */
export function handleGuardRequest(request: GuardRequest): GuardReply {
  try {
    return { id: request.id, decision: evaluateGuard(request.tool, request.input, request.ctx) }
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : 'guard failed' }
  }
}

/** The decision when a check cannot finish: blocked, whatever the settings say. */
export function failedDecision(why: 'timeout' | 'error' | 'busy'): GuardDecision {
  const what =
    why === 'timeout'
      ? 'took too long to check'
      : why === 'busy'
        ? 'could not be checked (too many checks at once)'
        : 'could not be checked'
  return {
    action: 'deny',
    category: 'disk',
    ruleId: 'disk.uncheckable',
    reasonForModel: `ClaudeDeck guard (Disk and system): this tool call ${what}, so it was blocked. Split it into smaller commands, or tell the user.`,
    messageForUser: `ClaudeDeck guard blocked a tool call that ${what}.`
  }
}

interface Job {
  request: GuardRequest
  done: (decision: GuardDecision) => void
}

export function createGuardRunner(opts: {
  spawn: () => WorkerLike
  timeoutMs?: number
  maxPending?: number
}): GuardRunner {
  const timeoutMs = opts.timeoutMs ?? GUARD_TIMEOUT_MS
  const maxPending = opts.maxPending ?? MAX_PENDING
  let worker: WorkerLike | null = null
  let current: (Job & { timer: ReturnType<typeof setTimeout> }) | null = null
  const queue: Job[] = []
  let nextId = 1
  let stopped = false

  const finish = (decision: GuardDecision): void => {
    if (!current) return
    clearTimeout(current.timer)
    const { done } = current
    current = null
    done(decision)
    pump()
  }

  /** Drops the worker (it is restarted for the next check). */
  const discard = (): void => {
    const w = worker
    worker = null
    if (w) void Promise.resolve(w.terminate()).catch(() => undefined)
  }

  const start = (): WorkerLike => {
    const w = opts.spawn()
    w.unref?.()
    w.on('message', (reply: GuardReply) => {
      if (w !== worker || !current || reply.id !== current.request.id) return
      if ('decision' in reply) finish(reply.decision)
      else {
        console.error('[guard] check failed in the worker')
        finish(failedDecision('error'))
      }
    })
    const lost = (): void => {
      if (w !== worker) return
      worker = null
      finish(failedDecision('error'))
    }
    w.on('error', (error: Error) => {
      console.error('[guard] worker error', error.message)
      lost()
    })
    w.on('exit', lost)
    return w
  }

  function pump(): void {
    if (current || stopped) return
    const job = queue.shift()
    if (!job) return
    const timer = setTimeout(() => {
      console.warn('[guard] check timed out; restarting the worker')
      discard()
      finish(failedDecision('timeout'))
    }, timeoutMs)
    current = { ...job, timer }
    try {
      worker ??= start()
      worker.postMessage(job.request)
    } catch (error) {
      console.error('[guard] could not start the worker', error)
      discard()
      finish(failedDecision('error'))
    }
  }

  return {
    evaluate(tool, input, ctx) {
      if (stopped || queue.length >= maxPending) return Promise.resolve(failedDecision('busy'))
      return new Promise((done) => {
        queue.push({ request: { id: nextId++, tool, input, ctx }, done })
        pump()
      })
    },
    stop() {
      stopped = true
      discard()
      if (current) finish(failedDecision('error'))
      for (const job of queue.splice(0)) job.done(failedDecision('error'))
    }
  }
}
