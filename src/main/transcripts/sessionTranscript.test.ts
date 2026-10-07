import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTail, feedTail } from './jsonlTail'
import {
  parseSessionLine,
  parseTaskNotifications,
  watchSessionTranscript,
  type SessionTranscriptEvent
} from './sessionTranscript'

const FIXTURE = join(__dirname, 'fixtures', 'parent-session.jsonl')

const fixtureEvents = (): SessionTranscriptEvent[] =>
  feedTail(createTail(), readFileSync(FIXTURE)).flatMap((l) => parseSessionLine(l.value))

describe('parseSessionLine', () => {
  it('extracts tool results and task notifications from a session transcript', () => {
    expect(fixtureEvents()).toEqual([
      {
        type: 'toolResult',
        toolUseId: 'toolu_bg0001',
        isError: false,
        agentResult: {
          agentId: 'abg00000000000001',
          status: 'async_launched',
          resolvedModel: 'claude-opus-5-5'
        },
        at: Date.parse('2026-10-07T10:00:03.000Z')
      },
      {
        type: 'toolResult',
        toolUseId: 'toolu_fg0001',
        isError: false,
        agentResult: {
          agentId: 'afg00000000000001',
          status: 'completed',
          resolvedModel: 'claude-sonnet-5'
        },
        at: Date.parse('2026-10-07T10:02:00.000Z')
      },
      {
        type: 'taskNotification',
        taskId: 'abg00000000000001',
        toolUseId: 'toolu_bg0001',
        status: 'completed',
        at: Date.parse('2026-10-07T10:05:00.000Z')
      },
      {
        type: 'taskNotification',
        taskId: 'bsh0001',
        toolUseId: 'toolu_sh0001',
        status: 'failed',
        exitCode: 143,
        at: Date.parse('2026-10-07T10:06:00.000Z')
      }
    ])
  })

  it('reports errors and leaves agentResult out for ordinary tools', () => {
    const events = parseSessionLine({
      type: 'user',
      timestamp: 'not a date',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: 'boom' }]
      },
      toolUseResult: 'Error: boom'
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'toolResult', toolUseId: 'toolu_x', isError: true })
    expect(events[0]).not.toHaveProperty('agentResult')
    expect(Number.isFinite(events[0].at)).toBe(true)
  })

  it('ignores other shapes', () => {
    expect(parseSessionLine({ type: 'assistant', message: { content: [] } })).toEqual([])
    expect(parseSessionLine({ type: 'user', message: { content: 'text' } })).toEqual([])
    expect(
      parseSessionLine({ type: 'user', message: { content: [{ type: 'tool_result' }] } })
    ).toEqual([])
    expect(
      parseSessionLine({ type: 'queue-operation', operation: 'enqueue', content: 42 })
    ).toEqual([])
  })
})

describe('parseTaskNotifications', () => {
  it('rejects unsafe ids and statuses and reads negative exit codes', () => {
    const block = (id: string, status: string, summary = ''): string =>
      `<task-notification><task-id>${id}</task-id><tool-use-id>toolu_1</tool-use-id><status>${status}</status><summary>${summary}</summary></task-notification>`
    expect(parseTaskNotifications(block('../etc', 'completed'), 1)).toEqual([])
    expect(parseTaskNotifications(block('ok1', 'done; rm'), 1)).toEqual([])
    expect(parseTaskNotifications(block('ok1', 'failed', 'exit code -2'), 1)).toEqual([
      {
        type: 'taskNotification',
        taskId: 'ok1',
        toolUseId: 'toolu_1',
        status: 'failed',
        exitCode: -2,
        at: 1
      }
    ])
    expect(parseTaskNotifications(block('a', 'completed') + block('b', 'killed'), 5)).toHaveLength(
      2
    )
  })
})

describe('watchSessionTranscript', () => {
  let dir: string
  let file: string
  let stop: (() => void) | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cd-session-'))
    file = join(dir, 'session.jsonl')
  })
  afterEach(() => {
    stop?.()
    stop = null
    rmSync(dir, { recursive: true, force: true })
  })

  const notification = (taskId: string): string =>
    `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-10-07T10:00:00.000Z',
      content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>toolu_${taskId}</tool-use-id><status>completed</status></task-notification>`
    })}\n`

  const taskIds = (events: SessionTranscriptEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'taskNotification' ? [e.taskId] : []))

  it('waits for the file and then reads it from the beginning', async () => {
    const events: SessionTranscriptEvent[] = []
    stop = watchSessionTranscript(file, (e) => events.push(e), { pollMs: 20, watch: false })
    await new Promise((r) => setTimeout(r, 60))
    writeFileSync(file, notification('t1'))
    await vi.waitFor(() => expect(taskIds(events)).toEqual(['t1']), { timeout: 2000 })
    appendFileSync(file, notification('t2'))
    await vi.waitFor(() => expect(taskIds(events)).toEqual(['t1', 't2']), { timeout: 2000 })
  })

  it('starts at the end of an existing file unless an initial scan is asked for', async () => {
    writeFileSync(file, notification('old'))
    const plain: SessionTranscriptEvent[] = []
    const scanned: SessionTranscriptEvent[] = []
    const stopPlain = watchSessionTranscript(file, (e) => plain.push(e), { pollMs: 20 })
    stop = watchSessionTranscript(file, (e) => scanned.push(e), {
      pollMs: 20,
      initialScan: true,
      watch: false
    })
    await vi.waitFor(() => expect(taskIds(scanned)).toEqual(['old']), { timeout: 2000 })
    appendFileSync(file, notification('new'))
    await vi.waitFor(() => expect(taskIds(scanned)).toEqual(['old', 'new']), { timeout: 2000 })
    await vi.waitFor(() => expect(taskIds(plain)).toEqual(['new']), { timeout: 2000 })
    stopPlain()
  })

  it('emits nothing after stop', async () => {
    const listener = vi.fn()
    stop = watchSessionTranscript(file, listener, { pollMs: 20, watch: false })
    stop()
    writeFileSync(file, notification('late'))
    await new Promise((r) => setTimeout(r, 80))
    expect(listener).not.toHaveBeenCalled()
  })
})
