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

export const LIMITS = {
  title: 200,
  id: 100,
  message: 2000,
  itemChars: 2000,
  items: 50,
  rationaleBytes: 8 * 1024,
  summaryBytes: 8 * 1024,
  previewBytes: 32 * 1024,
  path: 1024
} as const

const bytes = (max: number): z.ZodString =>
  z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= max, `Must be at most ${max} bytes`)

const line = (max: number): z.ZodString => z.string().trim().min(1).max(max)
const list = (max: number): z.ZodArray<z.ZodString> => z.array(line(max)).max(LIMITS.items)

const RECORDED = new TextReply('Recorded.')

export function createOptimizeTools(port: OptimizePort): OptimizeTools {
  return {
    optimize_status: defineTool(
      'optimize',
      'Tell the user in one short sentence what you are doing right now.',
      { message: line(LIMITS.message) },
      (args, scope) => {
        port.status(scope, args.message)
        return RECORDED
      }
    ),

    optimize_findings: defineTool(
      'optimize',
      'Report what you found in the profile, once, before proposing changes.',
      {
        summary: bytes(LIMITS.summaryBytes),
        strengths: list(LIMITS.itemChars),
        issues: list(LIMITS.itemChars)
      },
      (args, scope) => {
        port.findings(scope, args)
        return RECORDED
      }
    ),

    optimize_ask: defineTool(
      'optimize',
      'Propose ONE change and wait for the user. Returns "Decision: apply", "Decision: skip" or ' +
        '"Decision: modify. User note: ...". Never edit files without an apply or modify answer.',
      {
        id: line(LIMITS.id),
        title: line(LIMITS.title),
        rationale: bytes(LIMITS.rationaleBytes),
        files: list(LIMITS.path),
        preview: bytes(LIMITS.previewBytes).optional()
      },
      async (args, scope) => new TextReply(await port.ask(scope, args))
    ),

    optimize_finish: defineTool(
      'optimize',
      'End the optimization with a short summary and the list of changes you applied.',
      { summary: bytes(LIMITS.summaryBytes), changes: list(LIMITS.itemChars) },
      (args, scope) => {
        port.finish(scope, args)
        return new TextReply('Finished. Stop now.')
      }
    )
  }
}
