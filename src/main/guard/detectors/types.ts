import type { Cmd } from '../commands'
import type { LocationEnv } from '../locations'

/** A rule that matched part of a tool call. */
export interface Hit {
  ruleId: string
  /** Index of the command in the parsed list; absent for whole-input matches. */
  cmd?: number
  /** The match is uncertain (unknown folder or variable): at most `ask`, never `deny`. */
  cap?: 'ask'
  /** Extra words for the reason ("to the default branch main"). */
  detail?: string
  /** Text shown in the log and the terminal message. */
  excerpt: string
}

export interface DetectContext extends LocationEnv {
  /** Whole input (heredoc bodies included) for text scans. */
  input: string
  /** Current branch of the working folder; null when not on a branch, undefined when unknown. */
  gitBranch?: string | null
  /** Port of ClaudeDeck's hook server (`lsof -ti :PORT | xargs kill`). */
  hookPort?: number
  /** ClaudeDeck's own process ids (`kill -STOP <pid>`). */
  ownPids?: readonly number[]
}

/** Looks at one command; `all` is the whole list (pipelines, earlier downloads). */
export type CmdDetector = (cmd: Cmd, index: number, ctx: DetectContext, all: Cmd[]) => Hit[]

export const hit = (ruleId: string, cmd: Cmd, index: number, extra: Partial<Hit> = {}): Hit => ({
  ruleId,
  cmd: index,
  excerpt: cmd.raw,
  ...extra
})
