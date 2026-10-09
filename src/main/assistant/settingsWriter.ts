import { randomUUID } from 'node:crypto'
import { DomainError } from '../../shared/errors'
import type { AssistantChangeInput } from '../../shared/assistant'
import type { AppState } from '../../shared/types'
import type { Repository } from '../state/repository'
import { dryRun } from './proposals'
import type { AssistantCatalog } from './settingsSpec'
import { AssistantValidationError } from './settingsSpec'
import {
  applySetter,
  restoreCall,
  targetValue,
  uniqueTargets,
  type Target
} from './settingsTargets'

/**
 * Follow-up work the IPC setters do after a write (hooks, menu bar, login item, menu language).
 * The writer compares the state before and after and calls only what changed.
 */
export interface SettingsEffects {
  /** The guard was switched on or off (accounts' hooks follow). */
  guardEnabledChanged(): void
  /** Global or project test queue settings changed (hooks and scheduler follow). */
  testQueueChanged(): void
  /** Usage display or menu bar settings changed. */
  usageChanged(): void
  languageChanged(): void
  launchAtLoginChanged(enabled: boolean): void
  /** Pushed to the renderers after every write. */
  stateChanged(state: AppState): void
}

/** How long an apply can be undone. */
export const UNDO_TTL_MS = 10 * 60 * 1000
const MAX_UNDO = 10

interface UndoEntry {
  saved: { target: Target; value: Record<string, unknown> | undefined }[]
  expiresAt: number
}

const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

export function runEffects(before: AppState, after: AppState, effects: SettingsEffects): void {
  const a = before.settings
  const b = after.settings
  if (a.guard.enabled !== b.guard.enabled) effects.guardEnabledChanged()
  const projectQueues = (s: AppState): unknown => s.projects.map((p) => [p.id, p.testQueue ?? null])
  if (changed(a.testQueue, b.testQueue) || changed(projectQueues(before), projectQueues(after))) {
    effects.testQueueChanged()
  }
  if (changed(a.usage, b.usage)) effects.usageChanged()
  if (a.language !== b.language) effects.languageChanged()
  if (a.launchAtLogin !== b.launchAtLogin) effects.launchAtLoginChanged(b.launchAtLogin)
  effects.stateChanged(after)
}

/**
 * Applies approved proposals through the repository setters and keeps the previous values of
 * every touched target for a single-use undo.
 */
export class SettingsWriter {
  private readonly undos = new Map<string, UndoEntry>()
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly deps: {
      repo: Repository
      catalog: AssistantCatalog
      effects: SettingsEffects
      now?: () => number
      newId?: () => string
    }
  ) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
  }

  /**
   * Re-validates the changes against the current settings (they may have been edited since the
   * proposal), then writes them. Nothing is written when any change is refused.
   */
  apply(changes: readonly AssistantChangeInput[]): { state: AppState; undoToken: string } {
    const { repo, catalog } = this.deps
    const before = repo.get()
    let calls
    try {
      calls = dryRun(changes, before, catalog).calls
    } catch (error) {
      if (error instanceof AssistantValidationError) {
        console.warn('[assistant] proposal no longer applies', error.message)
        throw new DomainError('INVALID')
      }
      throw error
    }
    const saved = uniqueTargets(calls).map((target) => ({
      target,
      value: targetValue(before, target)
    }))
    let state = before
    for (const call of calls) state = applySetter(repo, call)
    runEffects(before, state, this.deps.effects)
    return { state, undoToken: this.remember(saved) }
  }

  /** Puts back the values saved by `apply`; the token works once. */
  undo(token: string): AppState {
    this.prune()
    const entry = this.undos.get(token)
    if (!entry) throw new DomainError('INVALID')
    this.undos.delete(token)
    const { repo } = this.deps
    const before = repo.get()
    let state = before
    for (const { target, value } of entry.saved) {
      const call = restoreCall(target, value, state)
      if (!call) continue
      try {
        state = applySetter(repo, call)
      } catch (error) {
        console.warn('[assistant] could not restore', target.section, target.scope, error)
      }
    }
    runEffects(before, state, this.deps.effects)
    return state
  }

  private remember(saved: UndoEntry['saved']): string {
    this.prune()
    while (this.undos.size >= MAX_UNDO) this.undos.delete(this.undos.keys().next().value as string)
    const token = this.newId()
    this.undos.set(token, { saved, expiresAt: this.now() + UNDO_TTL_MS })
    return token
  }

  private prune(): void {
    const now = this.now()
    for (const [token, entry] of this.undos) if (entry.expiresAt <= now) this.undos.delete(token)
  }
}
