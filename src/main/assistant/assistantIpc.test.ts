import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { Handler } from '../ipcUtil'
import { registerAssistantIpc } from './assistantIpc'

function setup(): {
  call: (channel: string, ...args: unknown[]) => unknown
  manager: Record<string, ReturnType<typeof vi.fn>>
} {
  const handlers = new Map<string, Handler>()
  const manager = {
    start: vi.fn(),
    followUp: vi.fn(),
    cancel: vi.fn(),
    apply: vi.fn(),
    reject: vi.fn(),
    undo: vi.fn()
  }
  registerAssistantIpc({ handle: (channel, fn) => handlers.set(channel, fn), manager })
  return { call: (channel, ...args) => handlers.get(channel)?.(...args), manager }
}

describe('settings assistant IPC', () => {
  it('passes valid arguments through', () => {
    const { call, manager } = setup()
    call(IPC.assistantStart, { prompt: 'p', accountId: 'a1', section: 'guard', projectId: null })
    call(IPC.assistantFollowUp, 'r1', 'note')
    call(IPC.assistantApply, 'p1', ['bypass'])
    call(IPC.assistantApply, 'p2', undefined)
    call(IPC.assistantReject, 'p1')
    call(IPC.assistantCancel, 'r1')
    call(IPC.assistantUndo, 'u1')
    expect(manager.start).toHaveBeenCalledWith({ prompt: 'p', accountId: 'a1', section: 'guard' })
    expect(manager.followUp).toHaveBeenCalledWith('r1', 'note')
    expect(manager.apply).toHaveBeenNthCalledWith(1, 'p1', ['bypass'])
    expect(manager.apply).toHaveBeenNthCalledWith(2, 'p2', [])
    expect(manager.reject).toHaveBeenCalledWith('p1')
    expect(manager.cancel).toHaveBeenCalledWith('r1')
    expect(manager.undo).toHaveBeenCalledWith('u1')
  })

  it('refuses malformed input before the manager sees it', () => {
    const { call, manager } = setup()
    expect(() => call(IPC.assistantStart, null)).toThrow('INVALID')
    expect(() => call(IPC.assistantStart, { prompt: 1, accountId: 'a1' })).toThrow('INVALID')
    expect(() => call(IPC.assistantStart, { prompt: 'p', accountId: '' })).toThrow('INVALID')
    expect(() => call(IPC.assistantFollowUp, 'r1', 42)).toThrow('INVALID')
    expect(() => call(IPC.assistantApply, 'p1', 'bypass')).toThrow('INVALID')
    expect(() => call(IPC.assistantApply, 'p1', [1])).toThrow('INVALID')
    expect(() => call(IPC.assistantUndo, 'x'.repeat(201))).toThrow('INVALID')
    expect(manager.start).not.toHaveBeenCalled()
    expect(manager.apply).not.toHaveBeenCalled()
  })
})
