/**
 * "Edit settings with Claude": the user's own Claude (one of their ClaudeDeck accounts, run
 * headless) proposes settings changes through ClaudeDeck MCP tools; the user reviews and applies
 * them. Types shared by the main process (run manager, MCP tools, IPC) and the renderer.
 */
import type { AppState, GuardAction, GuardCategoryId, GuardTool } from './types'

/** Settings sections the assistant may change (v1). Accounts are out of scope. */
export const ASSISTANT_SECTIONS = ['guard', 'testQueue', 'claude', 'usage', 'general'] as const
export type AssistantSection = (typeof ASSISTANT_SECTIONS)[number]

export const isAssistantSection = (value: unknown): value is AssistantSection =>
  typeof value === 'string' && (ASSISTANT_SECTIONS as readonly string[]).includes(value)

export type AssistantScope = 'global' | 'project'

/** One change as Claude proposes it; `patch` follows the section schema (get_section_schema). */
export interface AssistantChangeInput {
  section: AssistantSection
  scope: AssistantScope
  projectId?: string
  patch: Record<string, unknown>
}

/** A scalar setting value; null means unset (inherit, follow the category, automatic). */
export type AssistantValue = string | number | boolean | null

/** A custom rule or pattern as shown in a diff. */
export interface AssistantRuleItem {
  kind: 'prefix' | 'regex'
  pattern: string
  target?: 'canonical' | 'raw'
  /** Guard rules only. */
  action?: GuardAction
}

/**
 * One visible difference of a change. `field` is a dotted path inside the section
 * (`enabled`, `categories.docker`, `ruleOverrides.git.forcePush`, `auto.cpuHighPercent`).
 */
export type AssistantDiff =
  | { kind: 'set'; field: string; from: AssistantValue; to: AssistantValue }
  | { kind: 'ruleAdded'; field: 'customRules' | 'customPatterns'; rule: AssistantRuleItem }
  | { kind: 'ruleRemoved'; field: 'customRules' | 'customPatterns'; rule: AssistantRuleItem }
  | { kind: 'builtinOff'; id: string; label?: string }
  | { kind: 'builtinOn'; id: string; label?: string }

export interface AssistantChange {
  section: AssistantSection
  scope: AssistantScope
  projectId?: string
  /** Project name at proposal time (display only). */
  projectName?: string
  diffs: AssistantDiff[]
}

export type AssistantExampleKind = 'guard' | 'testQueue'
/** Guard actions, or whether the test queue would queue the command. */
export type AssistantOutcome = GuardAction | 'queued' | 'notQueued'

/** An example Claude tested, evaluated by ClaudeDeck before and after the change. */
export interface AssistantExample {
  kind: AssistantExampleKind
  input: string
  tool?: GuardTool
  projectId?: string
  expected?: AssistantOutcome
  before: AssistantOutcome
  after: AssistantOutcome
  /** Built-in or custom rule id that decided `after`. */
  ruleId?: string
}

/** Something the user should know before applying; computed by ClaudeDeck, not by Claude. */
export type AssistantRisk =
  | { kind: 'guardOff' }
  | { kind: 'guardRelaxed'; category: GuardCategoryId | 'custom'; to: GuardAction }
  | { kind: 'guardAllow'; category: GuardCategoryId }
  | { kind: 'bypass' }
  | { kind: 'testQueueOff' }

/** Confirmation dialogs the renderer shows before calling apply (same as manual edits). */
export type AssistantConfirmation = `guardAllow:${GuardCategoryId}` | 'bypass'

export interface AssistantProposal {
  id: string
  runId: string
  summary: string
  reason: string
  changes: AssistantChange[]
  examples: AssistantExample[]
  risks: AssistantRisk[]
  confirmations: AssistantConfirmation[]
}

export interface AssistantQuestion {
  id: string
  runId: string
  text: string
}

/** What Claude is doing right now; the window shows one short line per phase. */
export type AssistantPhase = 'starting' | 'thinking' | 'reading' | 'testing' | 'proposing'

export interface AssistantStatusEvent {
  runId: string
  phase: AssistantPhase
}

/**
 * The end of a turn or of the run:
 * - answered: Claude ended its turn with a message and no applied proposal; a follow-up continues.
 * - applied / rejected / cancelled: the run is over.
 */
export interface AssistantDoneEvent {
  runId: string
  outcome: 'answered' | 'applied' | 'rejected' | 'cancelled'
  message?: string
}

/** A turn that timed out, or a Claude process that failed. */
export type AssistantErrorCode = 'TIMEOUT' | 'FAILED'

export interface AssistantErrorEvent {
  runId: string
  code: AssistantErrorCode
  /** Plain text from Claude (clipped); shown as is, never as HTML. */
  detail?: string
}

export interface AssistantStartInput {
  prompt: string
  accountId: string
  /** The settings section the window was opened from (pre-scoped). */
  section?: AssistantSection
  /** The selected project, so "this project" can be resolved. */
  projectId?: string
}

export interface AssistantStartResult {
  runId: string
}

export interface AssistantApplyResult {
  state: AppState
  /** Single use; restores the previous values of everything the apply touched. */
  undoToken: string
  /** First changed section (the settings view navigates there). */
  section: AssistantSection
  /** `data-setting` keys of the changed rows (global changes only). */
  keys: string[]
}

export const ASSISTANT_LIMITS = {
  prompt: 4000,
  followUp: 2000,
  /** Clarifying questions per run. */
  questions: 2,
  summary: 200,
  reason: 400,
  question: 300,
  changes: 10,
  examples: 8,
  exampleInput: 2000
} as const
