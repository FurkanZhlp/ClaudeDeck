import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { Handler } from '../ipcUtil'
import { registerOptimizeIpc } from './optimizeIpc'

function setup(): {
  call: (channel: string, ...args: unknown[]) => unknown
  manager: Record<string, ReturnType<typeof vi.fn>>
} {
  const handlers = new Map<string, Handler>()
  const manager = {
    start: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    answer: vi.fn(),
    cancel: vi.fn(),
    revert: vi.fn()
  }
  registerOptimizeIpc({ handle: (channel, fn) => handlers.set(channel, fn), manager })
  return { call: (channel, ...args) => handlers.get(channel)?.(...args), manager }
}

describe('optimize IPC', () => {
  it('passes valid arguments through', () => {
    const { call, manager } = setup()
    call(IPC.optimizeStart, 'a1')
    call(IPC.optimizeAnswer, 'a1', 'p1', 'modify', 'note')
    call(IPC.optimizeAnswer, 'a1', 'p2', 'apply', null)
    call(IPC.optimizeRevert, 'a1')
    expect(manager.start).toHaveBeenCalledWith('a1')
    expect(manager.answer).toHaveBeenNthCalledWith(1, 'a1', 'p1', 'modify', 'note')
    expect(manager.answer).toHaveBeenNthCalledWith(2, 'a1', 'p2', 'apply', undefined)
    expect(manager.revert).toHaveBeenCalledWith('a1')
  })

  it('rejects bad arguments', () => {
    const { call, manager } = setup()
    expect(() => call(IPC.optimizeStart, 42)).toThrow('INVALID')
    expect(() => call(IPC.optimizeCancel, '')).toThrow('INVALID')
    expect(() => call(IPC.optimizeAnswer, 'a1', 'p1', 'delete')).toThrow('INVALID')
    expect(() => call(IPC.optimizeAnswer, 'a1', '', 'apply')).toThrow('INVALID')
    expect(() => call(IPC.optimizeAnswer, 'a1', 'p1', 'modify', 'x'.repeat(4097))).toThrow(
      'INVALID'
    )
    expect(manager.answer).not.toHaveBeenCalled()
  })
})
