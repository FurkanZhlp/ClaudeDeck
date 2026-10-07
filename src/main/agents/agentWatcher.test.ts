import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSummary } from '../../shared/types'
import { AgentSessionWatcher, MAX_EVENTS, type SessionLocation } from './agentWatcher'

const SID = '11111111-2222-4333-8444-555555555555'
const FIXTURES = join(__dirname, 'fixtures')
const at = (time: string): number => Date.parse(`2026-10-07T${time}Z`)
const iso = (ms: number): string => new Date(ms).toISOString()

let root: string
let projectDir: string
let parentFile: string
let subDir: string
let location: SessionLocation | null
let clock: number
let watcher: AgentSessionWatcher
let received: AgentEvent[]

const jsonl = (value: unknown): string => `${JSON.stringify(value)}\n`

const toolResult = (toolUseId: string, time: string, result: Record<string, unknown>): string =>
  jsonl({
    type: 'user',
    timestamp: `2026-10-07T${time}Z`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }]
    },
    toolUseResult: result
  })

const notification = (agentId: string, toolUseId: string, time: string): string =>
  jsonl({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: `2026-10-07T${time}Z`,
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`
  })

const textLine = (ms: number, text: string): string =>
  jsonl({
    type: 'assistant',
    timestamp: iso(ms),
    message: { model: 'claude-haiku-5', role: 'assistant', content: [{ type: 'text', text }] }
  })

function writeAgent(id: string, meta: Record<string, unknown>, transcript?: string): void {
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, `agent-${id}.meta.json`), JSON.stringify(meta))
  if (transcript !== undefined) writeFileSync(join(subDir, `agent-${id}.jsonl`), transcript)
}

const summary = (id: string): AgentSummary | undefined =>
  watcher.summaries().find((s) => s.agentId === id)

function makeWatcher(): AgentSessionWatcher {
  return new AgentSessionWatcher({
    locate: () => location,
    onChange: () => {},
    onEvents: (_id, events) => received.push(...events),
    now: () => clock,
    watchFiles: false,
    timing: { resolveMs: 20, activeScanMs: 20, idleScanMs: 20, debounceMs: 10, parentPollMs: 20 }
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cd-agents-'))
  projectDir = join(root, 'projects', '-work-demo')
  parentFile = join(projectDir, `${SID}.jsonl`)
  subDir = join(projectDir, SID, 'subagents')
  location = {
    projectDirs: [join(root, 'projects', '-missing'), projectDir],
    projectsRoot: join(root, 'projects'),
    claudeSessionId: SID
  }
  clock = at('10:00:20.000')
  received = []
  watcher = makeWatcher()
})

afterEach(() => {
  watcher.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('AgentSessionWatcher', () => {
  it('ignores a project folder whose real path leaves the projects folder', async () => {
    const outside = join(root, 'elsewhere')
    mkdirSync(join(outside, SID, 'subagents'), { recursive: true })
    writeFileSync(join(outside, `${SID}.jsonl`), '')
    copyFileSync(
      join(FIXTURES, 'agent-sample.jsonl'),
      join(outside, SID, 'subagents', 'agent-aout0000000000001.jsonl')
    )
    mkdirSync(join(root, 'projects'), { recursive: true })
    try {
      symlinkSync(outside, projectDir, 'junction')
    } catch {
      return // links refused (Windows without rights)
    }
    location = {
      projectDirs: [projectDir],
      projectsRoot: join(root, 'projects'),
      claudeSessionId: SID
    }
    await watcher.start()
    await new Promise((done) => setTimeout(done, 100))
    expect(watcher.summaries()).toEqual([])
  })

  it('skips symlinked agent files', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(parentFile, '')
    location = {
      projectDirs: [projectDir],
      projectsRoot: join(root, 'projects'),
      claudeSessionId: SID
    }
    mkdirSync(subDir, { recursive: true })
    const secret = join(root, 'secret.jsonl')
    copyFileSync(join(FIXTURES, 'agent-sample.jsonl'), secret)
    try {
      symlinkSync(secret, join(subDir, 'agent-alink000000000001.jsonl'))
      symlinkSync(secret, join(subDir, 'agent-alink000000000001.meta.json'))
    } catch {
      return
    }
    await watcher.start()
    const listed = summary('alink000000000001')
    expect(listed?.model ?? null).toBeNull()
    expect(listed?.description ?? '').toBe('')
    await expect(watcher.open('alink000000000001')).resolves.toEqual({ events: [], cursor: null })
  })

  it('waits for the session id and its folders, then lists agents', async () => {
    location = null
    await watcher.start()
    expect(watcher.summaries()).toEqual([])
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(parentFile, '')
    location = {
      projectDirs: [projectDir],
      projectsRoot: join(root, 'projects'),
      claudeSessionId: SID
    }
    writeAgent('afg00000000000001', {
      agentType: 'code-reviewer',
      description: 'Review code',
      toolUseId: 'toolu_fg0001',
      spawnDepth: 1,
      requestShape: 'foreground'
    })
    copyFileSync(
      join(FIXTURES, 'agent-sample.jsonl'),
      join(subDir, 'agent-afg00000000000001.jsonl')
    )
    await vi.waitFor(() => expect(watcher.summaries()).toHaveLength(1), { timeout: 3000 })
    expect(summary('afg00000000000001')).toMatchObject({
      agentType: 'code-reviewer',
      description: 'Review code',
      model: 'claude-sonnet-5',
      background: false,
      depth: 1,
      status: 'running',
      currentTool: 'Grep',
      currentToolInput: 'TODO',
      startedAt: at('10:00:01.500'),
      lastActivityAt: at('10:00:10.000')
    })
  })

  it('marks a foreground agent done when the parent gets its tool result', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(parentFile, '')
    writeAgent('afg00000000000001', {
      agentType: 'code-reviewer',
      toolUseId: 'toolu_fg0001',
      spawnDepth: 1
    })
    copyFileSync(
      join(FIXTURES, 'agent-sample.jsonl'),
      join(subDir, 'agent-afg00000000000001.jsonl')
    )
    await watcher.start()
    expect(summary('afg00000000000001')?.status).toBe('running')
    appendFileSync(
      parentFile,
      toolResult('toolu_fg0001', '10:00:12.000', {
        status: 'completed',
        agentId: 'afg00000000000001',
        resolvedModel: 'claude-sonnet-5'
      })
    )
    await vi.waitFor(() => expect(summary('afg00000000000001')?.status).toBe('done'), {
      timeout: 3000
    })
  })

  it('tracks a background agent until its task notification, idempotently', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(parentFile, '')
    const id = 'abg00000000000001'
    writeAgent(
      id,
      { agentType: 'security', toolUseId: 'toolu_bg0001', spawnDepth: 1 },
      textLine(at('10:00:05.000'), 'auditing')
    )
    await watcher.start()
    appendFileSync(
      parentFile,
      toolResult('toolu_bg0001', '10:00:03.000', {
        status: 'async_launched',
        agentId: id,
        resolvedModel: 'claude-opus-5-5'
      })
    )
    await vi.waitFor(() => expect(summary(id)?.background).toBe(true), { timeout: 3000 })
    expect(summary(id)?.status).toBe('running')
    appendFileSync(parentFile, notification(id, 'toolu_bg0001', '10:00:15.000'))
    await vi.waitFor(() => expect(summary(id)?.status).toBe('done'), { timeout: 3000 })
    appendFileSync(parentFile, notification(id, 'toolu_bg0001', '10:00:16.000'))
    await new Promise((r) => setTimeout(r, 80))
    expect(summary(id)?.status).toBe('done')
  })

  it('reads completions that happened before watching and from parent agents', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(parentFile, notification('abg00000000000001', 'toolu_bg0001', '10:00:15.000'))
    writeAgent(
      'abg00000000000001',
      { toolUseId: 'toolu_bg0001', requestShape: 'background' },
      textLine(at('10:00:05.000'), 'a')
    )
    writeAgent(
      'anested0000000001',
      { toolUseId: 'toolu_nested', spawnDepth: 2, parentAgentId: 'abg00000000000001' },
      textLine(at('10:00:07.000'), 'b')
    )
    appendFileSync(
      join(subDir, 'agent-abg00000000000001.jsonl'),
      toolResult('toolu_nested', '10:00:09.000', {
        status: 'completed',
        agentId: 'anested0000000001'
      })
    )
    await watcher.start()
    await vi.waitFor(() => expect(summary('abg00000000000001')?.status).toBe('done'), {
      timeout: 3000
    })
    expect(summary('anested0000000001')).toMatchObject({ status: 'done', depth: 2 })
  })

  it('falls back to idle after a quiet minute without pending tools', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeAgent(
      'aquiet00000000001',
      { toolUseId: 'toolu_q' },
      textLine(at('10:00:05.000'), 'thinking')
    )
    await watcher.start()
    expect(summary('aquiet00000000001')?.status).toBe('running')
    clock = at('10:01:06.000')
    expect(summary('aquiet00000000001')?.status).toBe('idle')
  })

  it('opens an agent, streams new events and pages back without gaps or duplicates', async () => {
    mkdirSync(projectDir, { recursive: true })
    const id = 'along000000000001'
    const count = 1500
    const body = Array.from({ length: count }, (_, i) =>
      textLine(at('10:00:00.000') + i, `line ${i} ${'p'.repeat(300)}`)
    )
    writeAgent(id, { toolUseId: 'toolu_l' }, body.join(''))
    await watcher.start()

    const first = await watcher.open(id)
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.events.length).toBeLessThanOrEqual(MAX_EVENTS)
    expect(first.cursor).not.toBeNull()
    expect(first.events.at(-1)?.text).toContain(`line ${count - 1} `)

    appendFileSync(join(subDir, `agent-${id}.jsonl`), textLine(at('10:00:30.000'), 'fresh'))
    await vi.waitFor(() => expect(received.map((e) => e.text)).toEqual(['fresh']), {
      timeout: 3000
    })

    const all = [...first.events]
    let cursor = first.cursor
    while (cursor !== null) {
      const page = await watcher.older(id, cursor)
      all.unshift(...page.events)
      expect(page.cursor === null || page.cursor < cursor).toBe(true)
      cursor = page.cursor
    }
    expect(all).toHaveLength(count)
    expect(new Set(all.map((e) => e.id)).size).toBe(count)
    expect(all[0].text).toContain('line 0 ')

    const again = await watcher.open(id)
    expect(again.events.at(-1)?.text).toBe('fresh')
    watcher.close(id)
    appendFileSync(join(subDir, `agent-${id}.jsonl`), textLine(at('10:00:31.000'), 'unseen'))
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toHaveLength(1)
  })

  it('validates ids and only opens known agents', async () => {
    mkdirSync(subDir, { recursive: true })
    await watcher.start()
    await expect(watcher.open('../etc')).rejects.toMatchObject({ code: 'INVALID' })
    await expect(watcher.open('aunknown')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(watcher.older('aunknown', 10)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(watcher.older('a1', -1)).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('suspend releases everything and locates again', async () => {
    mkdirSync(projectDir, { recursive: true })
    writeAgent('asusp000000000001', { toolUseId: 'toolu_s' }, textLine(at('10:00:05.000'), 'x'))
    await watcher.start()
    expect(watcher.summaries()).toHaveLength(1)
    location = null
    watcher.suspend()
    expect(watcher.summaries()).toEqual([])
    rmSync(join(projectDir, SID), { recursive: true })
    location = {
      projectDirs: [projectDir],
      projectsRoot: join(root, 'projects'),
      claudeSessionId: SID
    }
    writeAgent('anew0000000000001', { toolUseId: 'toolu_n' }, textLine(at('10:00:06.000'), 'y'))
    await vi.waitFor(
      () => expect(watcher.summaries().map((s) => s.agentId)).toEqual(['anew0000000000001']),
      { timeout: 3000 }
    )
  })
})
