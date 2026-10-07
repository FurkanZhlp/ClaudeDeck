import { isObject } from '../profile/settingsFile'

/** Claude's tool use ids (`toolu_…`); anything else cannot be matched later and passes through. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_AGENT_TYPE = 100
const MAX_COMMAND = 64 * 1024

export interface PreToolUse {
  command: string
  toolUseId: string
  agentId?: string
  agentType?: string
}

export interface PostToolUse {
  toolUseId: string
  /** The command moved to the background (run_in_background or auto-backgrounded). */
  background: boolean
  /** PostToolUseFailure with `is_interrupt`: the user stopped the call (Esc). */
  interrupted: boolean
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, max) : undefined
}

/** A PreToolUse payload for the Bash tool; null for anything the queue must not handle. */
export function parsePreToolUse(payload: unknown): PreToolUse | null {
  if (!isObject(payload) || payload.tool_name !== 'Bash') return null
  const input = payload.tool_input
  if (!isObject(input) || typeof input.command !== 'string') return null
  if (input.command.length > MAX_COMMAND || input.command.trim() === '') return null
  const toolUseId = payload.tool_use_id
  if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return null
  const agentId =
    typeof payload.agent_id === 'string' && AGENT_ID.test(payload.agent_id)
      ? payload.agent_id
      : undefined
  const agentType = agentId ? cleanText(payload.agent_type, MAX_AGENT_TYPE) : undefined
  return { command: input.command, toolUseId, agentId, agentType }
}

/** A PostToolUse / PostToolUseFailure payload for the Bash tool. */
export function parsePostToolUse(payload: unknown): PostToolUse | null {
  if (!isObject(payload) || payload.tool_name !== 'Bash') return null
  const toolUseId = payload.tool_use_id
  if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return null
  const response = payload.tool_response
  // Spike (2.1.282): PostToolUse fires at hand-off with backgroundTaskId, plus timedOutAfterMs
  // when the command was moved to the background by the Bash timeout.
  const background =
    payload.hook_event_name !== 'PostToolUseFailure' &&
    isObject(response) &&
    ((typeof response.backgroundTaskId === 'string' && response.backgroundTaskId !== '') ||
      typeof response.timedOutAfterMs === 'number')
  const interrupted =
    payload.hook_event_name === 'PostToolUseFailure' && payload.is_interrupt === true
  return { toolUseId, background, interrupted }
}
