import { describe, expect, it } from 'vitest'
import { createGuardKeys } from './guardKeys'

describe('guard keys', () => {
  it('maps a key to its account and keeps the previous key until the next rotation', () => {
    let n = 0
    const keys = createGuardKeys(() => String(++n).repeat(64).slice(0, 64))
    const first = keys.rotate('a')
    const other = keys.rotate('b')
    expect(keys.lookup(first)).toBe('a')
    expect(keys.lookup(other)).toBe('b')
    const second = keys.rotate('a')
    expect(keys.lookup(second)).toBe('a')
    expect(keys.lookup(first)).toBe('a')
    keys.rotate('a')
    expect(keys.lookup(first)).toBeNull()
    keys.forget('a')
    expect(keys.lookup(second)).toBeNull()
  })

  it('makes random 64 hex keys and refuses malformed ones', () => {
    const keys = createGuardKeys()
    const key = keys.rotate('a')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.lookup(key.toUpperCase())).toBeNull()
    expect(keys.lookup('')).toBeNull()
    expect(keys.lookup(`${key}0`)).toBeNull()
  })
})
