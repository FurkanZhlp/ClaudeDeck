import { describe, expect, it } from 'vitest'
import { createPricing, defaultPricing, normalizeModelId, type RawRates } from './pricing'

const rates = (input: number): RawRates => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  cache_creation_input_token_cost: input * 1.25,
  cache_read_input_token_cost: input * 0.1
})

const pricing = createPricing({
  'claude-opus-4-1-20250805': rates(15e-6),
  'claude-opus-4-5': rates(5e-6),
  'claude-opus-4-6': rates(5e-6),
  'claude-sonnet-4-20250514': rates(3e-6),
  'claude-sonnet-4-5': {
    ...rates(3e-6),
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 22.5e-6
  },
  'claude-haiku-4-5': rates(1e-6)
})

const zero = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }

describe('pricing resolution', () => {
  it('matches exact ids', () => {
    expect(pricing.resolve('claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  it('strips date suffixes and provider prefixes', () => {
    expect(pricing.resolve('claude-opus-4-6-20260205')).toBe('claude-opus-4-6')
    expect(pricing.resolve('anthropic/claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(pricing.resolve('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5')
    expect(pricing.resolve('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
  })

  it('finds the dated entry for an undated id', () => {
    expect(pricing.resolve('claude-opus-4-1')).toBe('claude-opus-4-1-20250805')
  })

  it('falls back to the newest family member', () => {
    expect(pricing.resolve('claude-opus-4-9')).toBe('claude-opus-4-6')
    expect(pricing.resolve('claude-haiku-7')).toBe('claude-haiku-4-5')
  })

  it('leaves unknown models unpriced', () => {
    expect(pricing.resolve('gpt-5')).toBeNull()
    expect(pricing.resolve('claude-unknown-1')).toBeNull()
    expect(pricing.cost('gpt-5', { ...zero, input: 1000 })).toBe(0)
  })
})

describe('pricing cost', () => {
  it('prices every token bucket', () => {
    const cost = pricing.cost('claude-haiku-4-5', {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 1_000_000
    })
    // 1 + 5 + 1.25 + 2 (1h writes at 2x input) + 0.1
    expect(cost).toBeCloseTo(9.35, 6)
  })

  it('applies the long-context tier above 200k prompt tokens', () => {
    const cost = pricing.cost('claude-sonnet-4-5', { ...zero, input: 300_000, output: 1000 })
    expect(cost).toBeCloseTo(300_000 * 6e-6 + 1000 * 22.5e-6, 9)
  })

  it('ships a snapshot that prices current Claude models', () => {
    for (const id of ['claude-opus-4-1', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5']) {
      expect(defaultPricing.resolve(id)).not.toBeNull()
    }
  })
})

describe('normalizeModelId', () => {
  it('handles vertex style ids', () => {
    expect(normalizeModelId('vertex_ai/claude-opus-4-1@20250805')).toBe('claude-opus-4-1-20250805')
  })
})
