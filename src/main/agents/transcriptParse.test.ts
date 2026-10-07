import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTail, feedTail } from '../transcripts/jsonlTail'
import {
  IDLE_AFTER_MS,
  INPUT_LIMIT,
  RESULT_LIMIT,
  RESUME_GRACE_MS,
  STALE_PENDING_MS,
  TEXT_LIMIT,
  applyActivity,
  buildSummary,
  clip,
  createActivity,
  currentTool,
  currentToolInput,
  deriveStatus,
  toolInputPreview,
  TOOL_PREVIEW_LIMIT,
  lineEvents,
  parseAgentMeta
} from './transcriptParse'

const fixture = (name: string): Buffer => readFileSync(join(__dirname, 'fixtures', name))
const lines = feedTail(createTail(), fixture('agent-sample.jsonl'))
const t = (time: string): number => Date.parse(`2026-10-07T${time}Z`)

describe('lineEvents', () => {
  const events = lines.flatMap(lineEvents)

  it('normalises a subagent transcript', () => {
    expect(events.map((e) => [e.kind, e.tool ?? e.text?.slice(0, 20)])).toEqual([
      ['system', 'Review the diff.'],
      ['text', 'Looking at the diff '],
      ['tool_use', 'Bash'],
      ['tool_result', ' src/app.ts | 4 ++--'],
      ['tool_use', 'Read'],
      ['tool_result', 'export const app = 1'],
      ['system', 'Conversation compact'],
      ['text', 'No issues found.'],
      ['tool_use', 'Grep']
    ])
  })

  it('keeps ids stable per line offset and block', () => {
    const again = feedTail(createTail(), fixture('agent-sample.jsonl')).flatMap(lineEvents)
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id))
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length)
    expect(events[0].id).toBe('0:0')
  })

  it('pairs tool calls and results and previews input as plain text', () => {
    const bash = events.find((e) => e.tool === 'Bash')
    expect(bash).toMatchObject({ toolUseId: 'toolu_a1', inputPreview: 'git diff --stat' })
    expect(events.find((e) => e.tool === 'Read')?.inputPreview).toBe(
      '{"file_path":"/work/demo/src/app.ts"}'
    )
    const results = events.filter((e) => e.kind === 'tool_result')
    expect(results[0]).toMatchObject({ toolUseId: 'toolu_a1', isError: false })
    expect(results[0].text).not.toContain('\u001b')
    expect(results[1]).toMatchObject({ toolUseId: 'toolu_a2', isError: true })
    expect(results[1].text).toBe('export const app = 1\n[image]')
    expect(events[0].at).toBe(t('10:00:01.500'))
  })

  it('truncates text, input and results', () => {
    const big = 'a'.repeat(10_000)
    const [text] = lineEvents({
      offset: 7,
      value: { type: 'assistant', message: { content: [{ type: 'text', text: big }] } }
    })
    expect(text.text?.length).toBe(TEXT_LIMIT + 1)
    const [use] = lineEvents({
      offset: 7,
      value: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { content: big } }]
        }
      }
    })
    expect(use.inputPreview?.length).toBe(INPUT_LIMIT + 1)
    const [result] = lineEvents({
      offset: 7,
      value: {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: big }] }
      }
    })
    expect(result.text?.length).toBe(RESULT_LIMIT + 1)
  })

  it('ignores unknown line types and malformed content', () => {
    expect(lineEvents({ offset: 0, value: { type: 'attachment' } })).toEqual([])
    expect(lineEvents({ offset: 0, value: { type: 'assistant', message: 'x' } })).toEqual([])
    expect(
      lineEvents({ offset: 0, value: { type: 'assistant', message: { content: [1, null] } } })
    ).toEqual([])
  })
})

describe('clip', () => {
  it('strips escapes and controls but keeps newlines and tabs', () => {
    expect(clip('\u001b[1mbold\u001b[0m\u0007\tx\ny', 100)).toBe('bold\tx\ny')
  })

  it('never splits a surrogate pair', () => {
    expect(clip('ab🙂cd', 3)).toBe('ab…')
  })
})

describe('activity', () => {
  it('tracks model, times and the pending tool', () => {
    const activity = createActivity()
    lines.forEach((l) => applyActivity(activity, l.value))
    expect(activity.model).toBe('claude-sonnet-5')
    expect(activity.firstAt).toBe(t('10:00:01.500'))
    expect(activity.lastAt).toBe(t('10:00:10.000'))
    expect([...activity.pending.keys()]).toEqual(['toolu_a3'])
    expect(currentTool(activity)).toBe('Grep')
  })

  it('has no current tool once every call has a result', () => {
    const activity = createActivity()
    lines.slice(0, 5).forEach((l) => applyActivity(activity, l.value))
    expect(currentTool(activity)).toBeUndefined()
  })
})

describe('deriveStatus', () => {
  const now = 1_000_000_000
  it.each([
    ['done after a completion', { doneAt: now - 10, lastActivityAt: now - 20 }, 0, 'done'],
    [
      'done within the resume grace',
      { doneAt: now - 10_000, lastActivityAt: now - 10_000 + RESUME_GRACE_MS },
      0,
      'done'
    ],
    [
      'running again after a resume',
      { doneAt: now - 30_000, lastActivityAt: now - 1000 },
      0,
      'running'
    ],
    ['running with recent activity', { doneAt: null, lastActivityAt: now - 1000 }, 0, 'running'],
    ['idle without activity', { doneAt: null, lastActivityAt: now - IDLE_AFTER_MS }, 0, 'idle'],
    [
      'running while a tool call is pending',
      { doneAt: null, lastActivityAt: now - 5 * IDLE_AFTER_MS },
      1,
      'running'
    ],
    [
      'idle when a pending call went stale',
      { doneAt: null, lastActivityAt: now - STALE_PENDING_MS },
      1,
      'idle'
    ]
  ] as const)('%s', (_name, times, pendingCount, expected) => {
    expect(deriveStatus({ ...times, pendingCount, now })).toBe(expected)
  })
})

describe('parseAgentMeta', () => {
  it('reads the spike format and tolerates older or odd ones', () => {
    expect(parseAgentMeta(JSON.parse(fixture('agent-sample.meta.json').toString()))).toEqual({
      agentType: 'code-reviewer',
      description: 'Review code',
      toolUseId: 'toolu_fg0001',
      spawnDepth: 1,
      requestShape: 'foreground',
      requestNonInteractive: true,
      stoppedByUser: false,
      model: null
    })
    expect(parseAgentMeta({ spawnDepth: 'x', stoppedByUser: true, model: 'm' })).toMatchObject({
      agentType: 'agent',
      description: '',
      toolUseId: null,
      spawnDepth: 1,
      requestShape: null,
      stoppedByUser: true,
      model: 'm'
    })
    expect(parseAgentMeta([])).toBeNull()
  })
})

describe('toolInputPreview', () => {
  it('picks the main argument as one short line', () => {
    expect(toolInputPreview({ command: 'pnpm   test\n  --run', timeout: 5 })).toBe(
      'pnpm test --run'
    )
    expect(toolInputPreview({ file_path: '/work/a.ts', limit: 10 })).toBe('/work/a.ts')
    expect(toolInputPreview({ pattern: 'TODO', path: 'src' })).toBe('TODO')
    expect(toolInputPreview({ url: 'https://example.com' })).toBe('https://example.com')
    expect(toolInputPreview({ other: 1 })).toBeUndefined()
    expect(toolInputPreview('x')).toBeUndefined()
    const long = toolInputPreview({ command: `echo \u001b[31m${'x'.repeat(500)}` }) as string
    expect(long.length).toBeLessThanOrEqual(TOOL_PREVIEW_LIMIT + 1)
    expect(long).not.toContain('\u001b')
  })

  it('is kept for the pending call and shown in running summaries', () => {
    const activity = createActivity()
    applyActivity(activity, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]
      }
    })
    expect(currentTool(activity)).toBe('Bash')
    expect(currentToolInput(activity)).toBe('pnpm test')
  })
})

describe('buildSummary', () => {
  const base = {
    agentId: 'a1',
    meta: parseAgentMeta({
      agentType: 'qa',
      description: 'd',
      spawnDepth: 2,
      requestShape: 'background'
    }),
    createdAt: 100,
    modifiedAt: 200,
    doneAt: null,
    launchedAsync: false,
    resolvedModel: 'resolved',
    now: 300
  }

  it('starts at the first timestamp, bounded by the file time when only the end was read', () => {
    const activity = createActivity()
    lines.forEach((l) => applyActivity(activity, l.value))
    const first = activity.firstAt as number
    expect(buildSummary({ ...base, activity, createdAt: first - 5000 }).startedAt).toBe(first)
    activity.partial = true
    expect(buildSummary({ ...base, activity, createdAt: first - 5000 }).startedAt).toBe(
      first - 5000
    )
    expect(buildSummary({ ...base, activity, createdAt: first + 5000 }).startedAt).toBe(first)
  })

  it('falls back to file times and the resolved model', () => {
    expect(buildSummary({ ...base, activity: createActivity() })).toEqual({
      agentId: 'a1',
      agentType: 'qa',
      description: 'd',
      model: 'resolved',
      background: true,
      depth: 2,
      status: 'running',
      startedAt: 100,
      lastActivityAt: 200
    })
  })

  it('marks agents stopped by the user as done and shows the current tool only while running', () => {
    const activity = createActivity()
    lines.forEach((l) => applyActivity(activity, l.value))
    const running = buildSummary({ ...base, activity, now: t('10:00:11.000'), queuedRunId: 'r1' })
    expect(running).toMatchObject({
      status: 'running',
      currentTool: 'Grep',
      currentToolInput: 'TODO',
      queuedRunId: 'r1',
      model: 'claude-sonnet-5'
    })
    const stopped = buildSummary({
      ...base,
      meta: parseAgentMeta({ agentType: 'qa', stoppedByUser: true }),
      activity,
      now: t('10:00:11.000')
    })
    expect(stopped.status).toBe('done')
    expect(stopped).not.toHaveProperty('currentTool')
    expect(stopped.background).toBe(false)
  })
})
