import { DomainError } from '../../shared/errors'
import type {
  AssistantChange,
  AssistantChangeInput,
  AssistantExample,
  AssistantExampleKind,
  AssistantOutcome,
  AssistantProposal
} from '../../shared/assistant'
import type {
  AppState,
  ClassifyResult,
  GuardDecision,
  GuardEvaluateRequest,
  GuardTool
} from '../../shared/types'
import type { ClassifyOptions } from '../testQueue/classifier'
import {
  AssistantValidationError,
  expandChange,
  type AssistantCatalog,
  type SetterCall
} from './settingsSpec'
import {
  applySetter,
  assessRisks,
  changedKeys,
  diffValues,
  scratchRepository,
  targetValue,
  uniqueTargets,
  type Target
} from './settingsTargets'

/** The real evaluators, run against any state (current or proposed); nothing is executed. */
export interface Evaluators {
  catalog: AssistantCatalog
  evaluateGuard(request: GuardEvaluateRequest, state: AppState): Promise<GuardDecision>
  classify(command: string, opts: ClassifyOptions): ClassifyResult
}

export interface ExampleInput {
  input: string
  kind?: AssistantExampleKind
  tool?: GuardTool
  projectId?: string
  expected?: AssistantOutcome
}

export interface ProposalInput {
  summary: string
  reason: string
  changes: AssistantChangeInput[]
  examples: ExampleInput[]
}

/** A checked proposal: what the user sees and what applying it writes. */
export interface BuiltProposal {
  view: Omit<AssistantProposal, 'id' | 'runId'>
  /** Setter calls in order, valid against the state the proposal was built on. */
  calls: SetterCall[]
  targets: Target[]
  after: AppState
}

const GUARD_OUTCOMES = new Set<AssistantOutcome>(['allow', 'ask', 'deny'])

/**
 * Validates every change in order (each against the result of the previous ones) and writes
 * them into a scratch copy of `state` through the repository setters. Throws
 * AssistantValidationError with a message Claude can act on.
 */
export function dryRun(
  changes: readonly AssistantChangeInput[],
  state: AppState,
  catalog: AssistantCatalog
): { calls: SetterCall[]; after: AppState } {
  const repo = scratchRepository(state)
  const calls: SetterCall[] = []
  changes.forEach((change, i) => {
    const call = expandChange(change, repo.get(), catalog, `changes[${i}]`)
    try {
      applySetter(repo, call)
    } catch (error) {
      if (error instanceof DomainError) {
        throw new AssistantValidationError(
          `changes[${i}]: the settings validator refused it (${error.code}); check the values against get_section_schema("${change.section}")`
        )
      }
      throw error
    }
    calls.push(call)
  })
  return { calls, after: repo.get() }
}

async function outcome(
  example: ExampleInput,
  kind: AssistantExampleKind,
  state: AppState,
  evaluators: Evaluators
): Promise<{ outcome: AssistantOutcome; ruleId?: string }> {
  if (kind === 'testQueue') {
    const s = state.settings.testQueue
    const project = state.projects.find((p) => p.id === example.projectId)
    const result = evaluators.classify(example.input, {
      disabledBuiltins: s.disabledBuiltins,
      customPatterns: s.customPatterns,
      projectOverrides: project?.testQueue
    })
    const queued = s.enabled && result.isTest
    return {
      outcome: queued ? 'queued' : 'notQueued',
      ...(result.ruleId ? { ruleId: result.ruleId } : {})
    }
  }
  if (!state.settings.guard.enabled) return { outcome: 'allow' }
  const decision = await evaluators.evaluateGuard(
    {
      input: example.input,
      ...(example.tool ? { tool: example.tool } : {}),
      ...(example.projectId ? { projectId: example.projectId } : {})
    },
    state
  )
  return { outcome: decision.action, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) }
}

/** Evaluates the examples before and after; an example that misses its expectation is refused. */
async function evaluateExamples(
  examples: readonly ExampleInput[],
  before: AppState,
  after: AppState,
  evaluators: Evaluators
): Promise<AssistantExample[]> {
  const results: AssistantExample[] = []
  const misses: string[] = []
  for (const [i, example] of examples.entries()) {
    if (example.projectId && !before.projects.some((p) => p.id === example.projectId)) {
      throw new AssistantValidationError(`examples[${i}].projectId: unknown project`)
    }
    const kind: AssistantExampleKind =
      example.kind ??
      (example.expected && !GUARD_OUTCOMES.has(example.expected) ? 'testQueue' : 'guard')
    if (example.expected) {
      const fits =
        kind === 'guard'
          ? GUARD_OUTCOMES.has(example.expected)
          : !GUARD_OUTCOMES.has(example.expected)
      if (!fits) {
        throw new AssistantValidationError(
          `examples[${i}].expected: use allow/ask/deny for guard examples and queued/notQueued for test queue examples`
        )
      }
    }
    const was = await outcome(example, kind, before, evaluators)
    const now = await outcome(example, kind, after, evaluators)
    results.push({
      kind,
      input: example.input,
      ...(example.tool ? { tool: example.tool } : {}),
      ...(example.projectId ? { projectId: example.projectId } : {}),
      ...(example.expected ? { expected: example.expected } : {}),
      before: was.outcome,
      after: now.outcome,
      ...(now.ruleId ? { ruleId: now.ruleId } : {})
    })
    if (example.expected && example.expected !== now.outcome) {
      misses.push(
        `examples[${i}] ${JSON.stringify(example.input)}: expected ${example.expected} but the proposed settings give ${now.outcome}${now.ruleId ? ` (rule ${now.ruleId})` : ''}`
      )
    }
  }
  if (misses.length > 0) {
    throw new AssistantValidationError(
      `${misses.join('; ')}. Fix the proposal (or the expectation) and call propose_changes again.`
    )
  }
  return results
}

/** Checks a proposal against `state` and prepares what the user sees. */
export async function buildProposal(
  input: ProposalInput,
  state: AppState,
  evaluators: Evaluators
): Promise<BuiltProposal> {
  const rules = evaluators.catalog.guardRules
  const { calls, after } = dryRun(input.changes, state, evaluators.catalog)
  const targets = uniqueTargets(calls)
  const changes: AssistantChange[] = []
  for (const target of targets) {
    const diffs = diffValues(
      targetValue(state, target) ?? {},
      targetValue(after, target) ?? {}
    ).map((diff) => {
      if (diff.kind !== 'builtinOff' && diff.kind !== 'builtinOn') return diff
      // English name as a fallback for built-ins without a translated label.
      const label = evaluators.catalog.testBuiltins.find((b) => b.id === diff.id)?.label
      return label ? { ...diff, label } : diff
    })
    if (diffs.length === 0) continue
    const projectName = state.projects.find((p) => p.id === target.projectId)?.name
    changes.push({ ...target, ...(projectName ? { projectName } : {}), diffs })
  }
  if (changes.length === 0) {
    throw new AssistantValidationError(
      'The proposal changes nothing: the settings already have these values. Tell the user, or propose a different change.'
    )
  }
  const examples = await evaluateExamples(input.examples, state, after, evaluators)
  const { risks, confirmations } = assessRisks(state, after, targets, rules)
  return {
    view: { summary: input.summary, reason: input.reason, changes, examples, risks, confirmations },
    calls,
    targets,
    after
  }
}

/** Row keys to highlight after applying (global changes only; project ones live elsewhere). */
export function highlightKeys(
  changes: readonly AssistantChange[],
  evaluators: Evaluators
): string[] {
  return changes
    .filter((c) => c.scope === 'global')
    .flatMap((c) => changedKeys(c.section, c.diffs, evaluators.catalog.guardRules))
}
