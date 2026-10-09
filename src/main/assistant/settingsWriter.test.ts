import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../shared/types'
import { testEvaluators, testRepository } from '../../test/assistant'
import type { Repository } from '../state/repository'
import { SettingsWriter, UNDO_TTL_MS, type SettingsEffects } from './settingsWriter'

const catalog = testEvaluators().catalog
let repo: Repository
let dir: string
let projectId: string
let effects: { [K in keyof SettingsEffects]: ReturnType<typeof vi.fn> }
let clock: number
let writer: SettingsWriter

const saved = (): AppState => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as AppState

beforeEach(() => {
  ;({ repo, dir, projectId } = testRepository())
  effects = {
    guardEnabledChanged: vi.fn(),
    testQueueChanged: vi.fn(),
    usageChanged: vi.fn(),
    languageChanged: vi.fn(),
    launchAtLoginChanged: vi.fn(),
    stateChanged: vi.fn()
  }
  clock = 1000
  let n = 0
  writer = new SettingsWriter({
    repo,
    catalog,
    effects: effects as unknown as SettingsEffects,
    now: () => clock,
    newId: () => `undo-${++n}`
  })
})

describe('settings assistant writer', () => {
  it('applies through the repository setters and runs only the matching effects', () => {
    const { state, undoToken } = writer.apply([
      {
        section: 'guard',
        scope: 'global',
        patch: { enabled: false, categories: { docker: 'deny' } }
      },
      { section: 'general', scope: 'global', patch: { language: 'en' } }
    ])
    expect(state.settings.guard).toMatchObject({ enabled: false, categories: { docker: 'deny' } })
    expect(saved().settings.guard.categories.docker).toBe('deny')
    expect(saved().settings.language).toBe('en')
    expect(undoToken).toBe('undo-1')
    expect(effects.guardEnabledChanged).toHaveBeenCalledTimes(1)
    expect(effects.languageChanged).toHaveBeenCalledTimes(1)
    expect(effects.testQueueChanged).not.toHaveBeenCalled()
    expect(effects.usageChanged).not.toHaveBeenCalled()
    expect(effects.launchAtLoginChanged).not.toHaveBeenCalled()
    expect(effects.stateChanged).toHaveBeenCalledWith(state)
  })

  it('undo restores every touched value once', () => {
    repo.setGuardSettings({
      customRules: [{ id: 'keep', kind: 'prefix', pattern: 'x*', action: 'ask' }]
    })
    const before = repo.get()
    const { undoToken } = writer.apply([
      {
        section: 'guard',
        scope: 'global',
        patch: { customRules: { remove: ['keep'] }, categories: { git: 'deny' } }
      },
      { section: 'testQueue', scope: 'project', projectId, patch: { mode: 'off' } },
      { section: 'claude', scope: 'project', projectId, patch: { permissionMode: 'plan' } },
      { section: 'general', scope: 'global', patch: { launchAtLogin: true } }
    ])
    expect(repo.get().projects[0].testQueue?.mode).toBe('off')
    expect(repo.get().projects[0].claude?.permissionMode).toBe('plan')
    const restored = writer.undo(undoToken)
    expect(restored.settings.guard).toEqual(before.settings.guard)
    expect(restored.projects[0]).toEqual(before.projects[0])
    expect(restored.settings.launchAtLogin).toBe(false)
    expect(effects.testQueueChanged).toHaveBeenCalledTimes(2)
    expect(effects.launchAtLoginChanged).toHaveBeenLastCalledWith(false)
    expect(() => writer.undo(undoToken)).toThrow('INVALID')
  })

  it('refuses a proposal that no longer applies and writes nothing', () => {
    repo.setGuardSettings({
      customRules: [{ id: 'gone', kind: 'prefix', pattern: 'x*', action: 'ask' }]
    })
    const changes = [
      {
        section: 'guard' as const,
        scope: 'global' as const,
        patch: { categories: { docker: 'deny' } }
      },
      {
        section: 'guard' as const,
        scope: 'global' as const,
        patch: { customRules: { remove: ['gone'] } }
      }
    ]
    repo.setGuardSettings({ customRules: [] })
    expect(() => writer.apply(changes)).toThrow('INVALID')
    expect(repo.get().settings.guard.categories.docker).toBe('ask')
    expect(effects.stateChanged).not.toHaveBeenCalled()
  })

  it('undo tokens expire', () => {
    const { undoToken } = writer.apply([
      { section: 'usage', scope: 'global', patch: { display: 'remaining' } }
    ])
    expect(effects.usageChanged).toHaveBeenCalledTimes(1)
    clock += UNDO_TTL_MS
    expect(() => writer.undo(undoToken)).toThrow('INVALID')
    expect(repo.get().settings.usage.display).toBe('remaining')
  })

  it('skips a project removed since the apply', () => {
    const { undoToken } = writer.apply([
      { section: 'guard', scope: 'project', projectId, patch: { categories: { docker: 'deny' } } }
    ])
    repo.removeProject(projectId)
    expect(() => writer.undo(undoToken)).not.toThrow()
  })
})
