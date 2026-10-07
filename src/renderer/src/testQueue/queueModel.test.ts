import { describe, expect, it } from 'vitest'
import type { TestRun, TestQueueSnapshot } from '@shared/types'
import { checkPattern, elapsedParts, groupRuns, waitingPosition } from './queueModel'

const run = (id: string, sessionId: string, state: TestRun['state']): TestRun => ({
  id,
  sessionId,
  projectId: 'p',
  accountId: 'a',
  command: 'pnpm test',
  ruleId: 'js.script',
  state,
  enqueuedAt: 0,
  forced: false,
  canStop: false
})

const snapshot = (runs: TestRun[]): TestQueueSnapshot => ({
  enabled: true,
  mode: 'fixed',
  limit: 2,
  runs,
  load: null,
  updatedAt: 0
})

describe('groupRuns', () => {
  it('splits slot holders from waiting runs and drops finished ones', () => {
    const groups = groupRuns(
      snapshot([
        run('1', 's1', 'running'),
        run('2', 's2', 'background'),
        run('3', 's3', 'starting'),
        run('4', 's1', 'queued'),
        run('5', 's2', 'done'),
        run('6', 's3', 'queued')
      ])
    )
    expect(groups.running.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(groups.waiting.map((r) => r.id)).toEqual(['4', '6'])
  })

  it('is empty without a snapshot', () => {
    expect(groupRuns(null)).toEqual({ running: [], waiting: [] })
  })
})

describe('waitingPosition', () => {
  const snap = snapshot([
    run('1', 's1', 'running'),
    run('2', 's2', 'queued'),
    run('3', 's1', 'queued')
  ])

  it('is the 1-based position among waiting runs', () => {
    expect(waitingPosition(snap, 's2')).toBe(1)
    expect(waitingPosition(snap, 's1')).toBe(2)
  })

  it('is null for a tab with nothing waiting', () => {
    expect(waitingPosition(snap, 's9')).toBeNull()
    expect(waitingPosition(null, 's1')).toBeNull()
  })
})

describe('elapsedParts', () => {
  it('uses at most two units', () => {
    expect(elapsedParts(0)).toEqual([[0, 'second']])
    expect(elapsedParts(45_400)).toEqual([[45, 'second']])
    expect(elapsedParts(190_000)).toEqual([
      [3, 'minute'],
      [10, 'second']
    ])
    expect(elapsedParts(120_000)).toEqual([[2, 'minute']])
    expect(elapsedParts(3_900_000)).toEqual([
      [1, 'hour'],
      [5, 'minute']
    ])
    expect(elapsedParts(7_200_000)).toEqual([[2, 'hour']])
  })

  it('never goes negative (clock skew)', () => {
    expect(elapsedParts(-5000)).toEqual([[0, 'second']])
  })
})

describe('checkPattern', () => {
  it('rejects empty and too long input', () => {
    expect(checkPattern('prefix', '  ', 300)).toEqual({ ok: false, reason: 'empty' })
    expect(checkPattern('prefix', 'x'.repeat(301), 300)).toEqual({ ok: false, reason: 'tooLong' })
  })

  it('reports regexes that do not compile', () => {
    const result = checkPattern('regex', 'make (e2e', 300)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('regex')
  })

  it('accepts valid rules; prefixes are not compiled', () => {
    expect(checkPattern('regex', '^make e2e', 300)).toEqual({ ok: true })
    expect(checkPattern('prefix', 'make (e2e*', 300)).toEqual({ ok: true })
  })
})
