import { stat, watch as fsWatch, type FSWatcher } from 'node:fs'
import {
  createTail,
  readLinesBefore,
  readNewLines,
  type JsonlLine,
  type TailState
} from './jsonlTail'

/** Completion notice of a background task (Bash run or subagent) in a session transcript. */
export interface TaskNotificationEvent {
  type: 'taskNotification'
  /** Background task id; for a subagent this is its agentId. */
  taskId: string
  /** tool_use id of the call that started the task. */
  toolUseId: string
  /** As written by Claude Code, e.g. `completed`, `failed`, `killed`. */
  status: string
  /** From the summary ("... exit code N"), when present. */
  exitCode?: number
  /** Line timestamp (epoch ms); receive time when the line has none. */
  at: number
}

/** Agent tool details attached to a tool_result line (`toolUseResult`). */
export interface AgentToolResult {
  agentId: string
  /** `completed` for a finished foreground agent, `async_launched` when it went to the background. */
  status: string
  resolvedModel: string | null
}

export interface ToolResultEvent {
  type: 'toolResult'
  toolUseId: string
  isError: boolean
  agentResult?: AgentToolResult
  at: number
}

export type SessionTranscriptEvent = TaskNotificationEvent | ToolResultEvent

export interface SessionTranscriptOptions {
  /**
   * Also emit events from the last `initialScanBytes` (256 KB with `initialScan: true`) of a file
   * that exists when watching starts. Otherwise only lines appended later are emitted. A file
   * that appears later is always read from its beginning.
   */
  initialScan?: boolean
  initialScanBytes?: number
  /** Existence and growth check interval; also the fallback when fs.watch misses changes. */
  pollMs?: number
  /** Use fs.watch for low latency (default true). */
  watch?: boolean
}

const DEFAULT_SCAN_BYTES = 256 * 1024
const DEFAULT_POLL_MS = 2000
const WATCH_DEBOUNCE_MS = 100

const ID = /^[A-Za-z0-9_-]{1,128}$/
const STATUS = /^[A-Za-z_-]{1,32}$/
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

/** First `<name>value</name>` in `text`; values are short and contain no markup. */
function tagValue(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]{0,512})</${name}>`).exec(text)
  return match ? match[1].trim() : null
}

const lineTime = (value: Record<string, unknown>): number => {
  const parsed = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Task notifications inside a queued message; the result body (free text) is never parsed. */
export function parseTaskNotifications(content: string, at: number): TaskNotificationEvent[] {
  const events: TaskNotificationEvent[] = []
  for (const match of content.matchAll(NOTIFICATION)) {
    const body = match[1]
    // Fixed tags come before <result>; cutting there keeps agent output from posing as tags.
    const head = body.split('<result>')[0]
    const taskId = tagValue(head, 'task-id')
    const toolUseId = tagValue(head, 'tool-use-id')
    const status = tagValue(head, 'status')
    if (!taskId || !ID.test(taskId) || !toolUseId || !ID.test(toolUseId)) continue
    if (!status || !STATUS.test(status)) continue
    const event: TaskNotificationEvent = { type: 'taskNotification', taskId, toolUseId, status, at }
    const exit = /exit code (-?\d{1,6})\b/.exec(tagValue(head, 'summary') ?? '')
    if (exit) event.exitCode = Number(exit[1])
    events.push(event)
  }
  return events
}

function agentResultOf(value: unknown): AgentToolResult | undefined {
  if (!isRecord(value)) return undefined
  const { agentId, status, resolvedModel } = value
  if (typeof agentId !== 'string' || !ID.test(agentId) || typeof status !== 'string') {
    return undefined
  }
  return {
    agentId,
    status,
    resolvedModel: typeof resolvedModel === 'string' && resolvedModel ? resolvedModel : null
  }
}

/**
 * Events in one transcript line: `queue-operation`/`enqueue` lines carrying
 * `<task-notification>` blocks, and `tool_result` blocks of user lines. Tolerates any shape.
 */
export function parseSessionLine(value: Record<string, unknown>): SessionTranscriptEvent[] {
  if (value.type === 'queue-operation') {
    if (value.operation !== 'enqueue' || typeof value.content !== 'string') return []
    if (!value.content.includes('<task-notification>')) return []
    return parseTaskNotifications(value.content, lineTime(value))
  }
  if (value.type !== 'user' || !isRecord(value.message)) return []
  const content = value.message.content
  if (!Array.isArray(content)) return []
  const results = content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      ID.test(block.tool_use_id)
  )
  const at = lineTime(value)
  // toolUseResult describes the line's single result; with several it is ambiguous.
  const agentResult = results.length === 1 ? agentResultOf(value.toolUseResult) : undefined
  return results.map((block) => {
    const event: ToolResultEvent = {
      type: 'toolResult',
      toolUseId: block.tool_use_id as string,
      isError: block.is_error === true,
      at
    }
    if (agentResult) event.agentResult = agentResult
    return event
  })
}

const exists = (path: string): Promise<boolean> =>
  new Promise((resolve) => stat(path, (error) => resolve(!error)))

/**
 * Tails a session's parent transcript and emits task notifications and tool results. Waits
 * (polling) for the file to appear. Returns a function that stops watching.
 */
export function watchSessionTranscript(
  path: string,
  onEvent: (event: SessionTranscriptEvent) => void,
  opts: SessionTranscriptOptions = {}
): () => void {
  const scanBytes = opts.initialScanBytes ?? (opts.initialScan ? DEFAULT_SCAN_BYTES : 0)
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const useWatch = opts.watch ?? true

  let stopped = false
  let tail: TailState | null = null
  let firstCheck = true
  let busy = false
  let again = false
  let watcher: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null

  const emit = (lines: JsonlLine[]): void => {
    for (const line of lines) {
      for (const event of parseSessionLine(line.value)) {
        if (stopped) return
        try {
          onEvent(event)
        } catch (error) {
          console.warn('[transcripts] listener failed', error)
        }
      }
    }
  }

  const startWatcher = (): void => {
    if (!useWatch || watcher || stopped) return
    try {
      watcher = fsWatch(path, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          void pump()
        }, WATCH_DEBOUNCE_MS)
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }

  const begin = async (): Promise<boolean> => {
    const present = await exists(path)
    const existedAtStart = firstCheck
    firstCheck = false
    if (!present || stopped) return false
    if (existedAtStart) {
      const page = await readLinesBefore(path, Number.MAX_SAFE_INTEGER, scanBytes)
      if (stopped) return false
      tail = createTail(page.end)
      emit(page.lines)
    } else {
      tail = createTail(0)
    }
    startWatcher()
    return true
  }

  const pump = async (): Promise<void> => {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        if (!tail && !(await begin())) break
        if (stopped || !tail) break
        emit(await readNewLines(path, tail))
      } while (again && !stopped)
    } catch (error) {
      console.warn('[transcripts] could not read session transcript', error)
    } finally {
      busy = false
    }
  }

  const poll = setInterval(() => void pump(), pollMs)
  poll.unref?.()
  void pump()

  return () => {
    stopped = true
    clearInterval(poll)
    if (debounce) clearTimeout(debounce)
    watcher?.close()
    watcher = null
  }
}
