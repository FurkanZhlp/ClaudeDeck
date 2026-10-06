import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import type { Repository } from '../state/repository'
import {
  createOptimizeTools,
  LIMITS,
  OptimizeRejection,
  type OptimizePort,
  type OptimizeTools
} from './optimizeTools'
import type { OptimizeScope, SessionScope } from './sessionTokens'
import { createTools, type ToolResult } from './tools'

const run: OptimizeScope = { kind: 'optimize', runId: 'r1', accountId: 'a1' }
const tab: SessionScope = { kind: 'session', sessionId: 's1', projectId: 'p1', accountId: 'a1' }

const textOf = (r: ToolResult): string => r.content[0].text

function setup(overrides: Partial<OptimizePort> = {}): {
  tools: OptimizeTools
  port: OptimizePort
} {
  const port: OptimizePort = {
    status: vi.fn(),
    findings: vi.fn(),
    ask: vi.fn(() => Promise.resolve('Decision: apply')),
    finish: vi.fn(),
    ...overrides
  }
  return { tools: createOptimizeTools(port), port }
}

const proposal = {
  id: 'q1',
  title: 'Merge duplicate rules',
  rationale: 'Two sections say the same.',
  files: ['CLAUDE.md'],
  preview: '```diff\n-a\n+b\n```'
}

describe('optimize tools', () => {
  it('delegates each tool to the port with the caller scope', async () => {
    const { tools, port } = setup()
    expect(textOf(await tools.optimize_status.call({ message: 'Reading agents' }, run))).toBe(
      'Recorded.'
    )
    expect(port.status).toHaveBeenCalledWith(run, 'Reading agents')

    const findings = { summary: 'Solid', strengths: ['Clear tone'], issues: ['Duplicates'] }
    await tools.optimize_findings.call(findings, run)
    expect(port.findings).toHaveBeenCalledWith(run, findings)

    const asked = await tools.optimize_ask.call(proposal, run)
    expect(asked.isError).toBeFalsy()
    expect(textOf(asked)).toBe('Decision: apply')
    expect(port.ask).toHaveBeenCalledWith(run, proposal)

    const done = await tools.optimize_finish.call({ summary: 'Done', changes: ['x'] }, run)
    expect(textOf(done)).toMatch(/Finished/)
    expect(port.finish).toHaveBeenCalledWith(run, { summary: 'Done', changes: ['x'] })
  })

  it('refuses session scopes', async () => {
    const { tools, port } = setup()
    for (const tool of Object.values(tools)) {
      const result = await tool.call({ message: 'x' }, tab)
      expect(result).toMatchObject({ isError: true, content: [{ text: 'Not allowed' }] })
      expect(tool.scopeKind).toBe('optimize')
    }
    expect(port.status).not.toHaveBeenCalled()
  })

  it('validates and limits input', async () => {
    const { tools, port } = setup()
    const tooLong = 'x'.repeat(LIMITS.title + 1)
    expect((await tools.optimize_ask.call({ ...proposal, title: tooLong }, run)).isError).toBe(true)
    const bigPreview = 'x'.repeat(LIMITS.previewBytes + 1)
    expect((await tools.optimize_ask.call({ ...proposal, preview: bigPreview }, run)).isError).toBe(
      true
    )
    const manyFiles = Array.from({ length: LIMITS.items + 1 }, (_, i) => `f${i}`)
    expect((await tools.optimize_ask.call({ ...proposal, files: manyFiles }, run)).isError).toBe(
      true
    )
    const longStatus = await tools.optimize_status.call(
      { message: 'x'.repeat(LIMITS.message + 1) },
      run
    )
    expect(longStatus.isError).toBe(true)
    expect(textOf(longStatus)).toMatch(/Shorten it/)
    const longIssue = 'x'.repeat(LIMITS.item + 1)
    const findings = { summary: 'Ok', strengths: [], issues: [longIssue] }
    expect((await tools.optimize_findings.call(findings, run)).isError).toBe(true)
    const longRationale = 'x'.repeat(LIMITS.rationale + 1)
    expect(
      (await tools.optimize_ask.call({ ...proposal, rationale: longRationale }, run)).isError
    ).toBe(true)
    expect((await tools.optimize_status.call({ message: '' }, run)).isError).toBe(true)
    expect((await tools.optimize_status.call({ message: 'a', extra: 1 }, run)).isError).toBe(true)
    expect(port.ask).not.toHaveBeenCalled()
    expect(port.status).not.toHaveBeenCalled()
    expect(port.findings).not.toHaveBeenCalled()
  })

  it('reports port rejections as tool errors with their message', async () => {
    const { tools } = setup({
      ask: () => {
        throw new OptimizeRejection('Another question is already waiting for the user.')
      }
    })
    const result = await tools.optimize_ask.call(proposal, run)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Another question is already waiting for the user.')
  })
})

describe('project tools with an optimize scope', () => {
  it('refuses every project and notes tool', async () => {
    const repo = {
      get: () => {
        throw new DomainError('UNKNOWN')
      }
    } as unknown as Repository
    const tools = createTools({
      repo,
      notes: { list: () => [], read: () => '', write: () => undefined },
      requestOpenSession: vi.fn(),
      notifyStateChanged: vi.fn(),
      confirm: vi.fn()
    })
    for (const tool of Object.values(tools)) {
      expect(tool.scopeKind).toBe('session')
      expect(await tool.call({}, run)).toMatchObject({
        isError: true,
        content: [{ text: 'Not allowed' }]
      })
    }
  })
})
