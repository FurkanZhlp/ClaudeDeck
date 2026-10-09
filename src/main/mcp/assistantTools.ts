import { z } from 'zod'
import { ASSISTANT_LIMITS as LIMITS, ASSISTANT_SECTIONS } from '../../shared/assistant'
import type { AssistantSection } from '../../shared/assistant'
import { GUARD_LIMITS } from '../../shared/guardLimits'
import type { ExampleInput, ProposalInput } from '../assistant/proposals'
import type { AssistantScope } from './sessionTokens'
import { defineTool, TextReply, ToolError, type Tool } from './tools'

export { ToolError as AssistantRejection }

/**
 * What the settings assistant tools need from the run that owns the token. Implementations
 * throw `AssistantRejection` with a message that is safe to show to Claude.
 */
export interface AssistantPort {
  overview(scope: AssistantScope): unknown
  sectionSchema(scope: AssistantScope, section: AssistantSection): unknown
  testGuard(
    scope: AssistantScope,
    request: { input: string; tool?: GuardToolName; projectId?: string }
  ): Promise<unknown>
  classify(scope: AssistantScope, request: { command: string; projectId?: string }): unknown
  /** Resolves with the user's decision once they answered (or the run ended). */
  propose(scope: AssistantScope, proposal: ProposalInput): Promise<string>
  /** Resolves with the user's answer. */
  ask(scope: AssistantScope, question: string): Promise<string>
}

export type AssistantToolName =
  | 'get_settings_overview'
  | 'get_section_schema'
  | 'test_guard'
  | 'classify_test_command'
  | 'propose_changes'
  | 'ask_user'

export const ASSISTANT_TOOL_NAMES: readonly AssistantToolName[] = [
  'get_settings_overview',
  'get_section_schema',
  'test_guard',
  'classify_test_command',
  'propose_changes',
  'ask_user'
]

const GUARD_TOOLS = [
  'Bash',
  'PowerShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit'
] as const
type GuardToolName = (typeof GUARD_TOOLS)[number]

const tooLong = (max: number): string => `Too long: at most ${max} characters. Shorten it.`
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max, tooLong(max))
const id = z.string().trim().min(1).max(200)
const section = z.enum(ASSISTANT_SECTIONS)

const example = z
  .object({
    input: line(LIMITS.exampleInput),
    kind: z.enum(['guard', 'testQueue']).optional(),
    tool: z.enum(GUARD_TOOLS).optional(),
    projectId: id.optional(),
    expected: z.enum(['allow', 'ask', 'deny', 'queued', 'notQueued']).optional()
  })
  .strict()

const change = z
  .object({
    section,
    scope: z.enum(['global', 'project']),
    projectId: id.optional(),
    patch: z.record(z.string(), z.unknown())
  })
  .strict()

export function createAssistantTools(port: AssistantPort): Record<AssistantToolName, Tool> {
  return {
    get_settings_overview: defineTool(
      'assistant',
      'ClaudeDeck settings sections, what each controls, their current values, accounts and ' +
        'projects (ids and names). Call this first.',
      {},
      (_args, scope) => port.overview(scope)
    ),

    get_section_schema: defineTool(
      'assistant',
      'Allowed fields, value ranges, enums and built-in rule ids (with names and examples) of ' +
        'one section, and how list fields are edited. Call it before proposing changes to it.',
      { section },
      (args, scope) => port.sectionSchema(scope, args.section)
    ),

    test_guard: defineTool(
      'assistant',
      'Evaluate a command (or a file path for Write/Edit/MultiEdit/NotebookEdit) with the ' +
        'command guard and the CURRENT settings. Nothing is executed. Returns the action ' +
        '(allow/ask/deny) and the deciding rule.',
      {
        input: line(GUARD_LIMITS.maxEvaluateInput),
        tool: z.enum(GUARD_TOOLS).optional(),
        projectId: id.optional()
      },
      (args, scope) => port.testGuard(scope, args)
    ),

    classify_test_command: defineTool(
      'assistant',
      'Classify a command with the test queue rules and the CURRENT settings: whether it counts ' +
        'as a test run and which rule matched. Nothing is executed.',
      { command: line(64 * 1024), projectId: id.optional() },
      (args, scope) => port.classify(scope, args)
    ),

    propose_changes: defineTool(
      'assistant',
      'Propose settings changes to the user and wait for their decision. ClaudeDeck validates ' +
        'every patch with the same validators as manual edits (nothing is written) and evaluates ' +
        'the examples before and after the change; an invalid proposal or an example that does ' +
        'not give its expected result returns an error to fix. A valid proposal is shown to the ' +
        'user; the result is "applied", "cancelled" or "refine: <user note>" (then propose ' +
        "again). summary: one short sentence in the user's language. reason: one sentence. " +
        'examples: 1-8 commands that show the effect, with the expected outcome after the change.',
      {
        summary: line(LIMITS.summary),
        reason: line(LIMITS.reason),
        changes: z.array(change).min(1).max(LIMITS.changes),
        examples: z.array(example).max(LIMITS.examples)
      },
      async (args, scope) =>
        new TextReply(
          await port.propose(scope, {
            summary: args.summary,
            reason: args.reason,
            changes: args.changes,
            examples: args.examples as ExampleInput[]
          })
        )
    ),

    ask_user: defineTool(
      'assistant',
      `Ask the user one short clarifying question in their language and wait for the answer. ` +
        `At most ${LIMITS.questions} per run; prefer a sensible proposal over asking.`,
      { question: line(LIMITS.question) },
      async (args, scope) => new TextReply(await port.ask(scope, args.question))
    )
  }
}
