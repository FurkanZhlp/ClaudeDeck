import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { capEvents, mergeEvents, toItems } from './transcript'

const ev = (id: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  id,
  kind: 'text',
  at: 0,
  ...extra
})

describe('mergeEvents', () => {
  it('appends new events and drops duplicates', () => {
    const current = [ev('0:0'), ev('10:0')]
    const merged = mergeEvents(current, [ev('10:0'), ev('20:0'), ev('20:1')])
    expect(merged.map((e) => e.id)).toEqual(['0:0', '10:0', '20:0', '20:1'])
  })

  it('returns the same array when nothing is new', () => {
    const current = [ev('0:0')]
    expect(mergeEvents(current, [ev('0:0')])).toBe(current)
    expect(mergeEvents(current, [])).toBe(current)
  })

  it('orders by byte offset, then block index (older pages, early live events)', () => {
    const merged = mergeEvents([ev('300:0'), ev('300:1')], [ev('120:1'), ev('120:0'), ev('5:0')])
    expect(merged.map((e) => e.id)).toEqual(['5:0', '120:0', '120:1', '300:0', '300:1'])
  })
})

describe('capEvents', () => {
  it('keeps everything under the limit', () => {
    const events = [ev('0:0'), ev('10:0')]
    expect(capEvents(events, 7, 5)).toEqual({ events, cursor: 7 })
  })

  it('drops whole lines from the start and moves the cursor to the first kept line', () => {
    const events = [ev('0:0'), ev('10:0'), ev('10:1'), ev('10:2'), ev('20:0'), ev('30:0')]
    const result = capEvents(events, null, 4)
    expect(result.events.map((e) => e.id)).toEqual(['20:0', '30:0'])
    expect(result.cursor).toBe(20)
  })

  it('cuts at a line start without skipping it', () => {
    const events = [ev('0:0'), ev('0:1'), ev('10:0'), ev('20:0')]
    const result = capEvents(events, null, 2)
    expect(result.events.map((e) => e.id)).toEqual(['10:0', '20:0'])
    expect(result.cursor).toBe(10)
  })
})

describe('toItems', () => {
  it('attaches a result to its tool call and keeps orphans', () => {
    const items = toItems([
      ev('0:0', { kind: 'tool_result', toolUseId: 'old', text: 'orphan' }),
      ev('10:0', { kind: 'tool_use', toolUseId: 'a', tool: 'Bash' }),
      ev('20:0', { kind: 'tool_use', toolUseId: 'b', tool: 'Grep' }),
      ev('30:0', { kind: 'tool_result', toolUseId: 'a', isError: true }),
      ev('40:0', { kind: 'text', text: 'done' })
    ])
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ type: 'event', event: { id: '0:0' } })
    expect(items[1]).toMatchObject({ type: 'tool', call: { id: '10:0' }, result: { id: '30:0' } })
    expect(items[2]).toMatchObject({ type: 'tool', call: { id: '20:0' }, result: null })
    expect(items[3]).toMatchObject({ type: 'event', event: { id: '40:0' } })
  })
})
