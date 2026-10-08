import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { context } from '../../test/guard'
import {
  createGuardRunner,
  handleGuardRequest,
  type GuardReply,
  type GuardRequest,
  type WorkerLike
} from './guardRunner'

// Command STRINGS for the pure evaluator only; nothing here is ever executed.

/** A worker that answers with the real evaluator, or never (`hang`), or crashes (`crash`). */
class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false
  postMessage(request: GuardRequest): void {
    const command = (request.input as { command?: string }).command ?? ''
    if (command.includes('hang')) return
    if (command.includes('crash')) {
      setImmediate(() => this.emit('exit', 1))
      return
    }
    setImmediate(() => this.emit('message', handleGuardRequest(request) satisfies GuardReply))
  }
  terminate(): void {
    this.terminated = true
  }
}

describe('guard runner', () => {
  const ctx = context('mac')

  it('answers with the evaluator decision', async () => {
    const workers: FakeWorker[] = []
    const runner = createGuardRunner({ spawn: () => workers[workers.push(new FakeWorker()) - 1] })
    expect((await runner.evaluate('Bash', { command: 'rm -rf ~' }, ctx)).ruleId).toBe(
      'disk.systemDelete'
    )
    expect((await runner.evaluate('Bash', { command: 'ls' }, ctx)).action).toBe('allow')
    expect(workers).toHaveLength(1)
  })

  it('denies a check that takes too long and restarts the worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const workers: FakeWorker[] = []
    const runner = createGuardRunner({
      spawn: () => workers[workers.push(new FakeWorker()) - 1],
      timeoutMs: 50
    })
    const slow = runner.evaluate('Bash', { command: 'echo GUARD-SENTINEL-hang' }, ctx)
    const next = runner.evaluate('Bash', { command: 'ls' }, ctx)
    expect(await slow).toMatchObject({ action: 'deny', ruleId: 'disk.uncheckable' })
    expect(workers[0].terminated).toBe(true)
    expect((await next).action).toBe('allow')
    expect(workers).toHaveLength(2)
    warn.mockRestore()
  })

  it('denies when the worker dies and when too many checks wait', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runner = createGuardRunner({ spawn: () => new FakeWorker(), maxPending: 1 })
    expect(
      (await runner.evaluate('Bash', { command: 'echo GUARD-SENTINEL-crash' }, ctx)).action
    ).toBe('deny')
    const first = runner.evaluate('Bash', { command: 'ls' }, ctx)
    const second = runner.evaluate('Bash', { command: 'ls' }, ctx)
    const third = runner.evaluate('Bash', { command: 'ls' }, ctx)
    expect((await third).action).toBe('deny')
    expect((await first).action).toBe('allow')
    expect((await second).action).toBe('allow')
    runner.stop()
    expect((await runner.evaluate('Bash', { command: 'ls' }, ctx)).action).toBe('deny')
    error.mockRestore()
  })

  it('terminates a real worker thread stuck in a loop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A worker that never answers (an endless loop standing in for a runaway check).
    const runner = createGuardRunner({
      spawn: () =>
        new Worker(
          'require("node:worker_threads").parentPort.on("message", () => { for (;;) {} })',
          {
            eval: true
          }
        ) as unknown as WorkerLike,
      timeoutMs: 100
    })
    const start = Date.now()
    expect((await runner.evaluate('Bash', { command: 'ls' }, ctx)).action).toBe('deny')
    expect(Date.now() - start).toBeLessThan(2000)
    runner.stop()
    warn.mockRestore()
  })
})
