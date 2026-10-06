import { z } from 'zod'
import type { OptimizeScope } from './sessionTokens'
import { defineTool, TextReply, ToolError, type Tool } from './tools'

export { ToolError as OptimizeRejection }

export interface OptimizeFindings {
  summary: string
  strengths: string[]
  issues: string[]
}

export interface OptimizeProposal {
  id: string
  title: string
  rationale: string
  files: string[]
  preview?: string
}

export interface OptimizeFinish {
  summary: string
  changes: string[]
}

/**
 * What the optimize tools need from the run that owns the token. Implementations throw
 * `OptimizeRejection` with a message that is safe to show to Claude.
 */
export interface OptimizePort {
  status(scope: OptimizeScope, message: string): void
  findings(scope: OptimizeScope, findings: OptimizeFindings): void
  /** Resolves with the reply text once the user answered or the run was cancelled. */
  ask(scope: OptimizeScope, proposal: OptimizeProposal): Promise<string>
  finish(scope: OptimizeScope, result: OptimizeFinish): void
}

export type OptimizeToolName =
  'optimize_status' | 'optimize_findings' | 'optimize_ask' | 'optimize_finish'

export type OptimizeTools = Record<OptimizeToolName, Tool>

/**
 * Input limits. Text limits are in characters and leave some slack over the brevity the tool
 * descriptions ask for; the user reads these texts at a glance in the app.
 */
export const LIMITS = {
  id: 100,
  /** optimize_status message. */
  message: 100,
  /** Findings and finish summary. */
  summary: 300,
  /** One strength, issue or applied change. */
  item: 160,
  items: 50,
  title: 100,
  rationale: 600,
  previewBytes: 32 * 1024,
  path: 1024
} as const

const tooLong = (max: number): string =>
  `Too long: at most ${max} characters. Shorten it to a brief, plain sentence and call again.`

const bytes = (max: number): z.ZodString =>
  z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= max, `Must be at most ${max} bytes`)

const text = (max: number): z.ZodString => z.string().trim().max(max, tooLong(max))
const line = (max: number): z.ZodString => text(max).min(1)
const list = (max: number): z.ZodArray<z.ZodString> => z.array(line(max)).max(LIMITS.items)

const RECORDED = new TextReply('Recorded.')

export function createOptimizeTools(port: OptimizePort): OptimizeTools {
  return {
    optimize_status: defineTool(
      'optimize',
      'Tell the user what you are doing right now: a short, friendly, non-technical phrase in ' +
        'the user\'s language (max ~60 characters), e.g. "Looking at your agents". No file ' +
        'paths, patterns or tool names.',
      { message: line(LIMITS.message) },
      (args, scope) => {
        port.status(scope, args.message)
        return RECORDED
      }
    ),

    optimize_findings: defineTool(
      'optimize',
      'Report what you found in the profile, once, before proposing changes. summary: one ' +
        'sentence (max ~20 words). Each strength and issue: one short phrase (max ~12 words).',
      {
        summary: text(LIMITS.summary),
        strengths: list(LIMITS.item),
        issues: list(LIMITS.item)
      },
      (args, scope) => {
        port.findings(scope, args)
        return RECORDED
      }
    ),

    optimize_ask: defineTool(
      'optimize',
      'Propose ONE change and wait for the user. Returns "Decision: apply", "Decision: skip" or ' +
        '"Decision: modify. User note: ...". Never edit files without an apply or modify answer. ' +
        'title: max ~8 words. rationale: one plain sentence (max ~25 words); put details in ' +
        'preview, not in the rationale.',
      {
        id: line(LIMITS.id),
        title: line(LIMITS.title),
        rationale: text(LIMITS.rationale),
        files: list(LIMITS.path),
        preview: bytes(LIMITS.previewBytes).optional()
      },
      async (args, scope) => new TextReply(await port.ask(scope, args))
    ),

    optimize_finish: defineTool(
      'optimize',
      'End the optimization: summary in one sentence (max ~20 words) and the changes you ' +
        'applied, one short phrase each (max ~12 words).',
      { summary: text(LIMITS.summary), changes: list(LIMITS.item) },
      (args, scope) => {
        port.finish(scope, args)
        return new TextReply('Finished. Stop now.')
      }
    )
  }
}
