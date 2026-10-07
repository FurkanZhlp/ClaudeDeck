import { realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { PlatformPath } from 'node:path'
import { encodeProjectKey } from '../notes/memoryPath'

/** Agent and session ids as Claude Code writes them; anything else is never turned into a path. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export const isSafeId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_ID.test(value)

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.(jsonl|meta\.json)$/

/**
 * Per-project transcript folders a session may use under an account: the key of the project
 * path as stored (same as `transcriptPath`), then of its real path when that differs.
 */
export function projectDirCandidates(
  configDir: string,
  projectPath: string,
  p: PlatformPath = nodePath,
  realpath: (path: string) => string = realpathSync
): string[] {
  const dirs = [p.join(configDir, 'projects', encodeProjectKey(projectPath))]
  try {
    const real = realpath(projectPath)
    const alt = p.join(configDir, 'projects', encodeProjectKey(real))
    if (!dirs.includes(alt)) dirs.push(alt)
  } catch {
    // Missing project folder: only the stored path applies.
  }
  return dirs
}

/** The main conversation's transcript of a session. */
export function sessionTranscriptFile(
  projectDir: string,
  sessionId: string,
  p: PlatformPath = nodePath
): string {
  if (!isSafeId(sessionId)) throw new Error('invalid session id')
  return p.join(projectDir, `${sessionId}.jsonl`)
}

/** Folder holding a session's subagent transcripts. */
export function subagentsDirIn(
  projectDir: string,
  sessionId: string,
  p: PlatformPath = nodePath
): string {
  if (!isSafeId(sessionId)) throw new Error('invalid session id')
  return p.join(projectDir, sessionId, 'subagents')
}

/** `<configDir>/projects/<key>/<sessionId>/subagents` for the project path as stored. */
export function subagentsDir(
  configDir: string,
  projectPath: string,
  sessionId: string,
  p: PlatformPath = nodePath
): string {
  return subagentsDirIn(p.join(configDir, 'projects', encodeProjectKey(projectPath)), sessionId, p)
}

export interface AgentFiles {
  transcript: string
  meta: string
}

export function agentFiles(dir: string, agentId: string, p: PlatformPath = nodePath): AgentFiles {
  if (!isSafeId(agentId)) throw new Error('invalid agent id')
  return {
    transcript: p.join(dir, `agent-${agentId}.jsonl`),
    meta: p.join(dir, `agent-${agentId}.meta.json`)
  }
}

/** Agent id of a file in the subagents folder (`agent-<id>.jsonl` / `.meta.json`), or null. */
export function agentIdOfFile(name: string): string | null {
  const match = AGENT_FILE.exec(name)
  return match ? match[1] : null
}
