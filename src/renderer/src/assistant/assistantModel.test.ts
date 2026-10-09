import { describe, expect, it } from 'vitest'
import type { AssistantProposal } from '@shared/assistant'
import type { Account, Project } from '@shared/types'
import {
  defaultAccountId,
  describeDiff,
  pendingConfirmations,
  readLastAccount,
  reduceEvent,
  suggestionKeys,
  writeLastAccount,
  type DiffContext,
  type RunView
} from './assistantModel'

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars && 'value' in vars ? `${key}(${vars.value})` : key

const proposal = (runId: string): AssistantProposal => ({
  id: 'p1',
  runId,
  summary: 's',
  reason: 'r',
  changes: [],
  examples: [],
  risks: [],
  confirmations: []
})

describe('assistant run events', () => {
  const starting: RunView = { runId: null, view: { step: 'working', phase: 'starting' } }

  it('adopts the run from the first event while the start call is in flight', () => {
    const next = reduceEvent(starting, { type: 'status', runId: 'r1', phase: 'reading' })
    expect(next).toEqual({ runId: 'r1', view: { step: 'working', phase: 'reading' } })
  })

  it('ignores events of other runs', () => {
    const current: RunView = { runId: 'r1', view: { step: 'working', phase: 'thinking' } }
    expect(
      reduceEvent(current, { type: 'proposal', runId: 'old', proposal: proposal('old') })
    ).toBe(current)
  })

  it('moves to the proposal and keeps it when a late status arrives', () => {
    const shown = reduceEvent(
      { runId: 'r1', view: { step: 'working', phase: 'proposing' } },
      { type: 'proposal', runId: 'r1', proposal: proposal('r1') }
    )
    expect(shown.view.step).toBe('proposal')
    expect(reduceEvent(shown, { type: 'status', runId: 'r1', phase: 'thinking' })).toBe(shown)
  })

  it('shows questions, answered turns and errors', () => {
    const current: RunView = { runId: 'r1', view: { step: 'working', phase: 'thinking' } }
    expect(
      reduceEvent(current, {
        type: 'question',
        runId: 'r1',
        question: { id: 'q', runId: 'r1', text: 'Hangi proje?' }
      }).view
    ).toEqual({ step: 'question', question: { id: 'q', runId: 'r1', text: 'Hangi proje?' } })
    expect(
      reduceEvent(current, {
        type: 'done',
        runId: 'r1',
        event: { runId: 'r1', outcome: 'answered', message: 'Bu ayar burada yok.' }
      }).view
    ).toEqual({ step: 'answered', message: 'Bu ayar burada yok.' })
    expect(
      reduceEvent(current, { type: 'error', runId: 'r1', event: { runId: 'r1', code: 'TIMEOUT' } })
        .view
    ).toEqual({ step: 'error', code: 'TIMEOUT', detail: null })
    // The end of an applied or cancelled run changes nothing here (the window already moved on).
    expect(
      reduceEvent(current, {
        type: 'done',
        runId: 'r1',
        event: { runId: 'r1', outcome: 'cancelled' }
      })
    ).toBe(current)
  })
})

describe('assistant defaults', () => {
  const accounts = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] as Account[]
  const project = { id: 'p', accountId: 'a2' } as Project

  it('prefers the remembered account, then the project, the selection, the first', () => {
    expect(defaultAccountId(accounts, 'a3', project, 'a1')).toBe('a3')
    expect(defaultAccountId(accounts, 'gone', project, 'a1')).toBe('a2')
    expect(defaultAccountId(accounts, null, undefined, 'a1')).toBe('a1')
    expect(defaultAccountId(accounts, null, undefined, null)).toBe('a1')
    expect(defaultAccountId([], 'a1', project, 'a1')).toBeNull()
  })

  it('remembers the account and survives a storage that throws', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v)
    } as Storage
    writeLastAccount('a2', storage)
    expect(readLastAccount(storage)).toBe('a2')
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    } as unknown as Storage
    expect(readLastAccount(broken)).toBeNull()
    expect(() => writeLastAccount('a1', broken)).not.toThrow()
  })

  it('offers chips for the section, or a mix without one', () => {
    expect(suggestionKeys('guard')).toEqual([
      'assistant.suggestions.guard.0',
      'assistant.suggestions.guard.1',
      'assistant.suggestions.guard.2'
    ])
    expect(suggestionKeys(undefined)).toEqual([
      'assistant.suggestions.guard.0',
      'assistant.suggestions.testQueue.0',
      'assistant.suggestions.claude.0'
    ])
  })

  it('lists the confirmations still to ask', () => {
    expect(pendingConfirmations(['guardAllow:disk', 'bypass'], ['bypass'])).toEqual([
      'guardAllow:disk'
    ])
  })
})

describe('assistant diffs in plain language', () => {
  const ctx = (over: Partial<DiffContext> = {}): DiffContext => ({
    section: 'guard',
    scope: 'global',
    accounts: [{ id: 'a1', name: 'İş' } as Account],
    ...over
  })

  it('words guard categories and rule overrides like the settings view', () => {
    expect(
      describeDiff({ kind: 'set', field: 'categories.docker', from: 'ask', to: 'deny' }, ctx(), t)
    ).toEqual({
      kind: 'set',
      label: 'guard.categories.docker',
      from: 'guard.actions.ask',
      to: 'guard.actions.deny'
    })
    expect(
      describeDiff(
        { kind: 'set', field: 'ruleOverrides.git.forcePush', from: null, to: 'deny' },
        ctx(),
        t
      )
    ).toMatchObject({ label: 'guard.rules.git.forcePush', from: 'assistant.value.followCategory' })
    expect(
      describeDiff(
        { kind: 'set', field: 'categories.docker', from: null, to: 'allow' },
        ctx({ scope: 'project' }),
        t
      )
    ).toMatchObject({ from: 'assistant.value.inherit', to: 'guard.actions.allow' })
  })

  it('words switches, numbers with units, modes and accounts', () => {
    expect(
      describeDiff(
        { kind: 'set', field: 'enabled', from: false, to: true },
        ctx({ section: 'testQueue' }),
        t
      )
    ).toEqual({
      kind: 'set',
      label: 'testQueue.settings.enabled',
      from: 'assistant.value.off',
      to: 'assistant.value.on'
    })
    expect(
      describeDiff(
        { kind: 'set', field: 'maxWaitMinutes', from: 60, to: 30 },
        ctx({ section: 'testQueue' }),
        t
      )
    ).toMatchObject({ from: '60 testQueue.settings.unitMinutes' })
    expect(
      describeDiff(
        { kind: 'set', field: 'auto.cpuHighPercent', from: 85, to: 70 },
        ctx({ section: 'testQueue' }),
        t
      )
    ).toMatchObject({ to: 'assistant.value.percent(70)' })
    expect(
      describeDiff(
        { kind: 'set', field: 'permissionMode', from: 'default', to: 'plan' },
        ctx({ section: 'claude' }),
        t
      )
    ).toMatchObject({ label: 'permissions.mode', to: 'permissions.modes.plan' })
    expect(
      describeDiff(
        { kind: 'set', field: 'trayAccount', from: 'auto', to: 'a1' },
        ctx({ section: 'usage' }),
        t
      )
    ).toMatchObject({ from: 'settings.trayAccountAuto', to: 'İş' })
    expect(
      describeDiff(
        { kind: 'set', field: 'language', from: null, to: 'en' },
        ctx({ section: 'general' }),
        t
      )
    ).toMatchObject({ from: 'settings.languageSystem', to: 'English' })
  })

  it('shows rules and built-ins that come or go', () => {
    expect(
      describeDiff(
        {
          kind: 'ruleAdded',
          field: 'customRules',
          rule: { kind: 'prefix', pattern: 'terraform apply*', action: 'deny' }
        },
        ctx(),
        t
      )
    ).toEqual({
      kind: 'rule',
      added: true,
      rule: { kind: 'prefix', pattern: 'terraform apply*', action: 'deny' },
      action: 'guard.actions.deny'
    })
    expect(
      describeDiff({ kind: 'builtinOff', id: 'js.jest' }, ctx({ section: 'testQueue' }), t)
    ).toEqual({
      kind: 'builtin',
      on: false,
      label: 'testQueue.builtinLabels.js.jest'
    })
  })
})
