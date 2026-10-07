import type { AgentEvent, AgentStatus, AgentSummary } from '../../shared/types'
import type { JsonlLine } from '../transcripts/jsonlTail'

export const TEXT_LIMIT = 4096
export const INPUT_LIMIT = 1024
export const RESULT_LIMIT = 2048
/** No activity and no pending tool call for this long: the agent is shown as idle. */
export const IDLE_AFTER_MS = 60_000
/** A pending tool call without any activity for this long no longer keeps an agent running. */
export const STALE_PENDING_MS = 30 * 60_000
/** Activity this long after a completion means the agent was resumed. */
export const RESUME_GRACE_MS = 5000
const MAX_PENDING = 200

/** Fields of `agent-<id>.meta.json` the viewer uses (Claude Code 2.1.28x). */
export interface AgentMeta {
  agentType: string
  description: string
  toolUseId: string | null
  spawnDepth: number
  /** `background` or `foreground`; absent in older versions. */
  requestShape: string | null
  requestNonInteractive: boolean
  stoppedByUser: boolean
  /** Only some versions write it; the transcript's `message.model` is preferred. */
  model: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown, max = 512): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null

export function parseAgentMeta(value: unknown): AgentMeta | null {
  if (!isRecord(value)) return null
  const depth = value.spawnDepth
  return {
    agentType: str(value.agentType, 128) ?? 'agent',
    description: str(value.description) ?? '',
    toolUseId: str(value.toolUseId, 128),
    spawnDepth: Number.isInteger(depth) && (depth as number) > 0 ? (depth as number) : 1,
    requestShape: str(value.requestShape, 32),
    requestNonInteractive: value.requestNonInteractive === true,
    stoppedByUser: value.stoppedByUser === true,
    model: str(value.model, 128)
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Plain text without terminal escapes or control characters, cut to `limit` characters. */
export function clip(text: string, limit: number): string {
  const clean = text.replace(ANSI, '').replace(CONTROL, '')
  if (clean.length <= limit) return clean
  let end = limit
  const code = clean.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return `${clean.slice(0, end)}…`
}

function inputPreview(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (isRecord(input) && typeof input.command === 'string') return clip(input.command, INPUT_LIMIT)
  try {
    return clip(JSON.stringify(input) ?? '', INPUT_LIMIT)
  } catch {
    return undefined
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return clip(content, RESULT_LIMIT)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let length = 0
  for (const block of content) {
    if (length > RESULT_LIMIT) break
    if (!isRecord(block)) continue
    const part =
      block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : typeof block.type === 'string'
          ? `[${block.type}]`
          : ''
    parts.push(part)
    length += part.length
  }
  return clip(parts.join('\n'), RESULT_LIMIT)
}

export const lineTime = (value: Record<string, unknown>): number => {
  const parsed = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Normalises one subagent transcript line to viewer events. Ids derive from the line's byte
 * offset and block index, so the same line always yields the same ids.
 */
export function lineEvents(line: JsonlLine): AgentEvent[] {
  const { value, offset } = line
  const at = lineTime(value)
  const id = (index: number): string => `${offset}:${index}`

  if (value.type === 'system') {
    const text = str(value.content, TEXT_LIMIT * 2) ?? str(value.subtype, 128)
    return text ? [{ id: id(0), kind: 'system', at, text: clip(text, TEXT_LIMIT) }] : []
  }
  if ((value.type !== 'assistant' && value.type !== 'user') || !isRecord(value.message)) return []
  const content = value.message.content

  if (typeof content === 'string') {
    // A user line with plain text is the task prompt or a follow-up message to the agent.
    return content.trim()
      ? [{ id: id(0), kind: 'system', at, text: clip(content, TEXT_LIMIT) }]
      : []
  }
  if (!Array.isArray(content)) return []

  const events: AgentEvent[] = []
  content.forEach((block, index) => {
    if (!isRecord(block)) return
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      const kind = value.type === 'assistant' ? 'text' : 'system'
      events.push({ id: id(index), kind, at, text: clip(block.text, TEXT_LIMIT) })
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim()
    ) {
      events.push({ id: id(index), kind: 'thinking', at, text: clip(block.thinking, TEXT_LIMIT) })
    } else if (block.type === 'tool_use') {
      const event: AgentEvent = {
        id: id(index),
        kind: 'tool_use',
        at,
        tool: str(block.name, 128) ?? 'tool'
      }
      const toolUseId = str(block.id, 128)
      if (toolUseId) event.toolUseId = toolUseId
      const preview = inputPreview(block.input)
      if (preview !== undefined) event.inputPreview = preview
      events.push(event)
    } else if (block.type === 'tool_result') {
      const event: AgentEvent = {
        id: id(index),
        kind: 'tool_result',
        at,
        isError: block.is_error === true,
        text: resultText(block.content)
      }
      const toolUseId = str(block.tool_use_id, 128)
      if (toolUseId) event.toolUseId = toolUseId
      events.push(event)
    }
  })
  return events
}

/** What the summary needs from a subagent transcript, updated line by line. */
export interface AgentActivity {
  model: string | null
  firstAt: number | null
  lastAt: number | null
  /** tool_use id → tool name, in call order, for calls without a result yet. */
  pending: Map<string, string>
}

export const createActivity = (): AgentActivity => ({
  model: null,
  firstAt: null,
  lastAt: null,
  pending: new Map()
})

export function applyActivity(activity: AgentActivity, value: Record<string, unknown>): void {
  const at = lineTime(value)
  if (at > 0) {
    if (activity.firstAt === null || at < activity.firstAt) activity.firstAt = at
    if (activity.lastAt === null || at > activity.lastAt) activity.lastAt = at
  }
  if (!isRecord(value.message)) return
  const { model, content } = value.message
  // Synthetic messages (errors, interruptions) carry a placeholder like "<synthetic>".
  if (value.type === 'assistant' && typeof model === 'string' && model && !model.startsWith('<')) {
    activity.model = model.slice(0, 128)
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') continue
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      activity.pending.delete(block.id)
      activity.pending.set(block.id, str(block.name, 128) ?? 'tool')
      if (activity.pending.size > MAX_PENDING) {
        const oldest = activity.pending.keys().next().value
        if (oldest !== undefined) activity.pending.delete(oldest)
      }
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      activity.pending.delete(block.tool_use_id)
    }
  }
}

/** Tool of the last call still waiting for its result. */
export function currentTool(activity: AgentActivity): string | undefined {
  let last: string | undefined
  for (const name of activity.pending.values()) last = name
  return last
}

export interface StatusInput {
  /** Latest completion signal for this agent (epoch ms), or null. */
  doneAt: number | null
  lastActivityAt: number
  pendingCount: number
  now: number
}

/**
 * done: a completion signal and no activity after it (activity well after it means the agent
 * was resumed). running: a pending tool call or recent activity. idle: quiet for IDLE_AFTER_MS.
 */
export function deriveStatus({
  doneAt,
  lastActivityAt,
  pendingCount,
  now
}: StatusInput): AgentStatus {
  if (doneAt !== null && lastActivityAt <= doneAt + RESUME_GRACE_MS) return 'done'
  const quiet = now - lastActivityAt
  if (pendingCount > 0 && quiet < STALE_PENDING_MS) return 'running'
  return quiet >= IDLE_AFTER_MS ? 'idle' : 'running'
}

export interface SummaryInput {
  agentId: string
  meta: AgentMeta | null
  activity: AgentActivity
  /** File times used when the transcript has no timestamps yet. */
  createdAt: number
  modifiedAt: number
  doneAt: number | null
  /** The parent saw the Agent call go to the background (`async_launched`). */
  launchedAsync: boolean
  resolvedModel: string | null
  now: number
  queuedRunId?: string
}

export function buildSummary(input: SummaryInput): AgentSummary {
  const { meta, activity } = input
  const startedAt = activity.firstAt ?? input.createdAt
  const lastActivityAt = Math.max(activity.lastAt ?? input.modifiedAt, startedAt)
  const doneAt = meta?.stoppedByUser ? (input.doneAt ?? lastActivityAt) : input.doneAt
  const summary: AgentSummary = {
    agentId: input.agentId,
    agentType: meta?.agentType ?? 'agent',
    description: meta?.description ?? '',
    model: activity.model ?? input.resolvedModel ?? meta?.model ?? null,
    background: meta?.requestShape === 'background' || input.launchedAsync,
    depth: meta?.spawnDepth ?? 1,
    status: deriveStatus({
      doneAt,
      lastActivityAt,
      pendingCount: activity.pending.size,
      now: input.now
    }),
    startedAt,
    lastActivityAt
  }
  const tool = currentTool(activity)
  if (tool && summary.status === 'running') summary.currentTool = tool
  if (input.queuedRunId) summary.queuedRunId = input.queuedRunId
  return summary
}
