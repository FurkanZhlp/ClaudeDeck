import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../shared/errors'
import { IPC } from '../../shared/ipc'
import type { Account } from '../../shared/types'
import { registerUsageIpc } from './usageIpc'

const account = (id: string): Account => ({ id, name: id, color: '#000', configDir: `/x/${id}` })

const setup = (): {
  call: (channel: string, ...args: unknown[]) => unknown
  pollNow: ReturnType<typeof vi.fn>
} => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const pollNow = vi.fn()
  registerUsageIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    service: { list: () => [] },
    poller: { pollNow },
    repo: { get: () => ({ accounts: [account('a'), account('b')] }) },
    readPlan: (a) => ({ accountId: a.id, label: 'Pro', extraUsageEnabled: null })
  })
  return { call: (channel, ...args) => handlers.get(channel)?.(...args), pollNow }
}

describe('registerUsageIpc', () => {
  it('forces a poll for one account or all', () => {
    const { call, pollNow } = setup()
    expect(call(IPC.usagePollNow, 'a')).toBeNull()
    expect(pollNow).toHaveBeenLastCalledWith('a')
    expect(call(IPC.usagePollNow)).toBeNull()
    expect(pollNow).toHaveBeenLastCalledWith(undefined)
  })

  it('rejects a malformed account id', () => {
    const { call, pollNow } = setup()
    expect(() => call(IPC.usagePollNow, 42)).toThrow(DomainError)
    expect(pollNow).not.toHaveBeenCalled()
  })

  it('returns the plan of every account', () => {
    const { call } = setup()
    expect(call(IPC.usagePlans)).toEqual([
      { accountId: 'a', label: 'Pro', extraUsageEnabled: null },
      { accountId: 'b', label: 'Pro', extraUsageEnabled: null }
    ])
  })
})
