import {
  isAssistantSection,
  type AssistantDiff,
  type AssistantDoneEvent,
  type AssistantErrorEvent,
  type AssistantPhase,
  type AssistantProposal,
  type AssistantQuestion,
  type AssistantRuleItem,
  type AssistantScope,
  type AssistantSection,
  type AssistantValue
} from '@shared/assistant'
import type { Account, Project } from '@shared/types'

/**
 * Pure logic of the "edit settings with Claude" window: its steps and how run events move
 * between them, defaults, and how a proposed change reads in plain language.
 */

export type AssistantView =
  | { step: 'compose' }
  | { step: 'working'; phase: AssistantPhase }
  | { step: 'question'; question: AssistantQuestion }
  | { step: 'proposal'; proposal: AssistantProposal }
  | { step: 'answered'; message: string | null }
  | { step: 'error'; code: string; detail: string | null }

export type AssistantEvent =
  | { type: 'status'; runId: string; phase: AssistantPhase }
  | { type: 'proposal'; runId: string; proposal: AssistantProposal }
  | { type: 'question'; runId: string; question: AssistantQuestion }
  | { type: 'done'; runId: string; event: AssistantDoneEvent }
  | { type: 'error'; runId: string; event: AssistantErrorEvent }

export interface RunView {
  /** null while the start call is in flight (its first events adopt the run). */
  runId: string | null
  view: AssistantView
}

/**
 * The next window state for a run event. Events of other runs are ignored; while a start is
 * in flight (`runId` null and working) the first event names the run.
 */
export function reduceEvent(current: RunView, event: AssistantEvent): RunView {
  const adopting = current.runId === null && current.view.step === 'working'
  if (!adopting && event.runId !== current.runId) return current
  const runId = event.runId
  switch (event.type) {
    case 'status':
      // A status line only matters while Claude works; a late one must not hide a proposal.
      return current.view.step === 'working'
        ? { runId, view: { step: 'working', phase: event.phase } }
        : current
    case 'proposal':
      return { runId, view: { step: 'proposal', proposal: event.proposal } }
    case 'question':
      return { runId, view: { step: 'question', question: event.question } }
    case 'done':
      if (event.event.outcome === 'answered') {
        return { runId, view: { step: 'answered', message: event.event.message ?? null } }
      }
      return current
    case 'error':
      return {
        runId,
        view: { step: 'error', code: event.event.code, detail: event.event.detail ?? null }
      }
  }
}

/** Settings view section ids map to assistant sections; accounts and about have none. */
export const assistantSectionOf = (section: string): AssistantSection | undefined =>
  isAssistantSection(section) ? section : undefined

const SUGGESTION_COUNT: Record<AssistantSection, number> = {
  guard: 3,
  testQueue: 3,
  claude: 2,
  usage: 2,
  general: 2
}

/** i18n keys of the suggestion chips for a section (a mix when there is none). */
export function suggestionKeys(section: AssistantSection | undefined): string[] {
  if (section) {
    return Array.from(
      { length: SUGGESTION_COUNT[section] },
      (_, i) => `assistant.suggestions.${section}.${i}`
    )
  }
  return ['guard.0', 'testQueue.0', 'claude.0'].map((key) => `assistant.suggestions.${key}`)
}

const LAST_ACCOUNT_KEY = 'claudedeck.assistant.account'

/** Storage can be missing or throw (private mode, blocked site data); both fall back. */
export function readLastAccount(
  storage: Storage | undefined = globalThis.localStorage
): string | null {
  try {
    return storage?.getItem(LAST_ACCOUNT_KEY) ?? null
  } catch {
    return null
  }
}

export function writeLastAccount(
  accountId: string,
  storage: Storage | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(LAST_ACCOUNT_KEY, accountId)
  } catch {
    // Remembering the account is a convenience; losing it is fine.
  }
}

/**
 * The account a run starts with: the last one chosen when it still exists, otherwise the
 * selected project's, the selected account, or the first.
 */
export function defaultAccountId(
  accounts: readonly Account[],
  remembered: string | null,
  selectedProject: Project | undefined,
  selectedAccountId: string | null
): string | null {
  const exists = (id: string | null | undefined): id is string =>
    !!id && accounts.some((a) => a.id === id)
  if (exists(remembered)) return remembered
  if (exists(selectedProject?.accountId)) return selectedProject.accountId
  if (exists(selectedAccountId)) return selectedAccountId
  return accounts[0]?.id ?? null
}

/* --------------------------------------------------------------------------------------------
 * Plain-language diffs
 * ------------------------------------------------------------------------------------------ */

export type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface DiffContext {
  section: AssistantSection
  scope: AssistantScope
  accounts: readonly Account[]
}

/** Labels of fields that keep their settings view wording. */
const FIELD_KEYS: Record<string, string> = {
  'guard.enabled': 'guard.settings.enabled',
  'testQueue.enabled': 'testQueue.settings.enabled',
  'testQueue.mode': 'testQueue.settings.mode',
  'testQueue.maxConcurrent': 'testQueue.settings.maxConcurrent',
  'testQueue.auto.maxConcurrent': 'testQueue.settings.autoMax',
  'testQueue.auto.cpuHighPercent': 'testQueue.settings.cpuHigh',
  'testQueue.auto.cpuResumePercent': 'testQueue.settings.cpuResume',
  'testQueue.auto.minAvailableMemoryPercent': 'testQueue.settings.minMemory',
  'testQueue.auto.rampUpSeconds': 'testQueue.settings.rampUp',
  'testQueue.maxWaitMinutes': 'testQueue.settings.maxWait',
  'testQueue.startGraceSeconds': 'testQueue.settings.startGrace',
  'testQueue.backgroundMaxHoldMinutes': 'testQueue.settings.backgroundHold',
  'claude.permissionMode': 'permissions.mode',
  'claude.allowBypass': 'permissions.allowBypass',
  'usage.display': 'settings.usageDisplay',
  'usage.trayEnabled': 'settings.trayEnabled',
  'usage.trayMetric': 'settings.trayMetric',
  'usage.trayAccount': 'settings.trayAccount',
  'general.language': 'settings.language',
  'general.launchAtLogin': 'settings.launchAtLogin'
}

/** The field's name as the settings view shows it. */
export function fieldLabel(field: string, ctx: DiffContext, t: Translate): string {
  const [root, ...rest] = field.split('.')
  if (ctx.section === 'guard' && root === 'categories') return t(`guard.categories.${rest[0]}`)
  if (ctx.section === 'guard' && root === 'ruleOverrides') return t(`guard.rules.${rest.join('.')}`)
  if (ctx.section === 'claude' && ctx.scope === 'project') return t('permissions.projectLabel')
  const key = FIELD_KEYS[`${ctx.section}.${field}`]
  return key ? t(key) : field
}

const UNITS: Record<string, string> = {
  maxWaitMinutes: 'testQueue.settings.unitMinutes',
  backgroundMaxHoldMinutes: 'testQueue.settings.unitMinutes',
  startGraceSeconds: 'testQueue.settings.unitSeconds',
  'auto.rampUpSeconds': 'testQueue.settings.unitSeconds'
}

/** A value as the settings view words it (actions, modes, on/off, units). */
export function formatValue(
  field: string,
  value: AssistantValue,
  ctx: DiffContext,
  t: Translate
): string {
  const root = field.split('.')[0]
  const { section, scope } = ctx
  if (value === null) {
    if (section === 'guard' && root === 'ruleOverrides') return t('assistant.value.followCategory')
    if (section === 'testQueue' && field === 'auto.maxConcurrent') {
      return t('testQueue.settings.automatic')
    }
    if (section === 'general' && field === 'language') return t('settings.languageSystem')
    return scope === 'project' ? t('assistant.value.inherit') : t('assistant.value.none')
  }
  if (typeof value === 'boolean') return t(value ? 'assistant.value.on' : 'assistant.value.off')
  if (typeof value === 'number') {
    if (field.endsWith('Percent')) return t('assistant.value.percent', { value })
    const unit = UNITS[field]
    return unit ? `${value} ${t(unit)}` : String(value)
  }
  if (section === 'guard') return t(`guard.actions.${value}`)
  if (section === 'testQueue' && field === 'mode') {
    return scope === 'project'
      ? t(value === 'off' ? 'assistant.value.queueOff' : 'assistant.value.inherit')
      : t(`testQueue.mode.${value}`)
  }
  if (section === 'claude' && field === 'permissionMode') {
    return value === 'inherit' ? t('assistant.value.inherit') : t(`permissions.modes.${value}`)
  }
  if (section === 'usage') {
    if (field === 'display') {
      return t(value === 'remaining' ? 'settings.displayRemaining' : 'settings.displayUsed')
    }
    if (field === 'trayMetric') {
      const key = { session: 'metricSession', weekly: 'metricWeekly', both: 'metricBoth' }[value]
      return key ? t(`settings.${key}`) : value
    }
    if (field === 'trayAccount') {
      if (value === 'auto') return t('settings.trayAccountAuto')
      if (value === 'selected') return t('settings.trayAccountSelected')
      return ctx.accounts.find((a) => a.id === value)?.name ?? value
    }
  }
  if (section === 'general' && field === 'language') return value === 'tr' ? 'Türkçe' : 'English'
  return value
}

/** A diff line: a label with from and to, or a rule / built-in that comes or goes. */
export type DiffLine =
  | { kind: 'set'; label: string; from: string; to: string }
  | { kind: 'rule'; added: boolean; rule: AssistantRuleItem; action: string | null }
  | { kind: 'builtin'; on: boolean; label: string }

export function describeDiff(diff: AssistantDiff, ctx: DiffContext, t: Translate): DiffLine {
  switch (diff.kind) {
    case 'set':
      return {
        kind: 'set',
        label: fieldLabel(diff.field, ctx, t),
        from: formatValue(diff.field, diff.from, ctx, t),
        to: formatValue(diff.field, diff.to, ctx, t)
      }
    case 'ruleAdded':
    case 'ruleRemoved':
      return {
        kind: 'rule',
        added: diff.kind === 'ruleAdded',
        rule: diff.rule,
        action: diff.rule.action ? t(`guard.actions.${diff.rule.action}`) : null
      }
    case 'builtinOff':
    case 'builtinOn':
      return {
        kind: 'builtin',
        on: diff.kind === 'builtinOn',
        label: t(`testQueue.builtinLabels.${diff.id}`, {
          defaultValue: diff.label ?? diff.id
        })
      }
  }
}

/** Confirmations still to ask, in order; the apply call needs all of them. */
export function pendingConfirmations(
  required: readonly string[],
  accepted: readonly string[]
): string[] {
  return required.filter((c) => !accepted.includes(c))
}
