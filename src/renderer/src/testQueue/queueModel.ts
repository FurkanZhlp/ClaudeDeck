import type { TestRun, TestRunState, TestQueueSnapshot } from '@shared/types'

/** States that hold a slot. */
const ACTIVE: ReadonlySet<TestRunState> = new Set(['starting', 'running', 'background'])

export const isActiveRun = (run: TestRun): boolean => ACTIVE.has(run.state)
export const isWaitingRun = (run: TestRun): boolean => run.state === 'queued'

export interface QueueGroups {
  running: TestRun[]
  /** In queue order: index 0 starts next. */
  waiting: TestRun[]
}

/** Splits a snapshot into slot holders and waiting runs; finished runs are dropped. */
export function groupRuns(snapshot: TestQueueSnapshot | null): QueueGroups {
  const runs = snapshot?.runs ?? []
  return { running: runs.filter(isActiveRun), waiting: runs.filter(isWaitingRun) }
}

/**
 * 1-based queue position of the first waiting run of a tab, or null when the tab has none.
 * Subagents of the tab share it, so the earliest of them is what the tab is waiting on.
 */
export function waitingPosition(
  snapshot: TestQueueSnapshot | null,
  sessionId: string
): number | null {
  const index = groupRuns(snapshot).waiting.findIndex((run) => run.sessionId === sessionId)
  return index === -1 ? null : index + 1
}

const SECOND_MS = 1000
const MINUTE_S = 60
const HOUR_S = 3600

export type ElapsedUnit = 'hour' | 'minute' | 'second'

/** Elapsed time as at most two units, largest first: [[1, 'hour'], [5, 'minute']]. */
export function elapsedParts(ms: number): Array<[number, ElapsedUnit]> {
  const total = Math.max(0, Math.floor(ms / SECOND_MS))
  const hours = Math.floor(total / HOUR_S)
  const minutes = Math.floor((total % HOUR_S) / MINUTE_S)
  const seconds = total % MINUTE_S
  if (hours > 0)
    return minutes > 0
      ? [
          [hours, 'hour'],
          [minutes, 'minute']
        ]
      : [[hours, 'hour']]
  if (minutes > 0) {
    return seconds > 0
      ? [
          [minutes, 'minute'],
          [seconds, 'second']
        ]
      : [[minutes, 'minute']]
  }
  return [[seconds, 'second']]
}

/** Valid custom rule input, or the reason it is not (a locale key suffix plus detail). */
export type PatternCheck =
  { ok: true } | { ok: false; reason: 'empty' | 'tooLong' | 'regex'; detail?: string }

export function checkPattern(
  kind: 'prefix' | 'regex',
  pattern: string,
  maxLength: number
): PatternCheck {
  const text = pattern.trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > maxLength) return { ok: false, reason: 'tooLong' }
  if (kind === 'regex') {
    try {
      new RegExp(text)
    } catch (error) {
      return { ok: false, reason: 'regex', detail: error instanceof Error ? error.message : '' }
    }
  }
  return { ok: true }
}
