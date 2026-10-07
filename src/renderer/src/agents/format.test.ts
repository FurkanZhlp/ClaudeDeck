import { describe, expect, it } from 'vitest'
import { firstLine, formatElapsed, shortModel, splitLinks } from './format'

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [-500, '0:00'],
    [59_999, '0:59'],
    [61_000, '1:01'],
    [3_600_000 + 5 * 60_000 + 7_000, '1:05:07']
  ])('%i ms → %s', (ms, text) => expect(formatElapsed(ms)).toBe(text))
})

describe('shortModel', () => {
  it('drops the vendor prefix and the date', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
    expect(shortModel('claude-opus-4-1')).toBe('opus-4-1')
    expect(shortModel('custom')).toBe('custom')
  })
})

describe('firstLine', () => {
  it('returns the first non-empty line, shortened', () => {
    expect(firstLine('\n  pnpm test  \nmore')).toBe('pnpm test')
    expect(firstLine(undefined)).toBe('')
    expect(firstLine('abcdef', 4)).toBe('abc…')
  })
})

describe('splitLinks', () => {
  it('finds http(s) links and leaves trailing punctuation as text', () => {
    expect(splitLinks('See https://example.com/a?b=1. Done')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' },
      { kind: 'text', text: '. Done' }
    ])
  })

  it('ignores other schemes and markup', () => {
    expect(splitLinks('<a href="javascript:x">file:///etc</a>')).toEqual([
      { kind: 'text', text: '<a href="javascript:x">file:///etc</a>' }
    ])
  })
})
