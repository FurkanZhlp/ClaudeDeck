import snapshot from '../../../resources/pricing/claude-models.json'

/** LiteLLM field names, USD per token. */
export interface RawRates {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost_above_1hr?: number
  input_cost_per_token_above_200k_tokens?: number
  output_cost_per_token_above_200k_tokens?: number
  cache_creation_input_token_cost_above_200k_tokens?: number
  cache_read_input_token_cost_above_200k_tokens?: number
  cache_creation_input_token_cost_above_1hr_above_200k_tokens?: number
}

/** Token counts as they price: cache writes split by TTL (1h writes bill higher). */
export interface PricedTokens {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface Pricing {
  /** The catalog key a model id prices as, or null when unknown. */
  resolve(model: string): string | null
  /** USD cost of one request; 0 for unknown models. */
  cost(model: string, tokens: PricedTokens): number
}

/** Prompts above this many tokens bill at the long-context tier when the model has one. */
export const LONG_CONTEXT_THRESHOLD = 200_000
/** ccusage's rule for 1h cache writes when the catalog has no explicit rate. */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2
const DATE_SUFFIX = /-\d{8}$/
// Never fall back past `claude-<family>`.
const MIN_FAMILY_SEGMENTS = 2

/** Strips provider prefixes, region prefixes and version or context suffixes. */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase()
  id = id.replace(/\[[^\]]*\]$/, '')
  id = id.replace(/^(anthropic|bedrock|vertex_ai|openrouter)\//, '')
  id = id.replace(/^bedrock\/[^/]+\//, '')
  id = id.replace(/^(us|eu|apac|au|jp|global)\./, '')
  id = id.replace(/^anthropic\./, '')
  id = id.replace(/-v\d+(:\d+)?$/, '')
  id = id.replace(/@(\d{8})$/, '-$1').replace(/@.*$/, '')
  id = id.replace(/-latest$/, '')
  return id
}

const versionCompare = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** Newest member: undated aliases win over dated ids, then the highest version. */
function pickNewest(keys: string[]): string {
  const undated = keys.filter((k) => !DATE_SUFFIX.test(k))
  const pool = undated.length > 0 ? undated : keys
  return pool.reduce((best, k) => (versionCompare(k, best) > 0 ? k : best))
}

export function createPricing(models: Record<string, RawRates>): Pricing {
  const keys = Object.keys(models)
  const memo = new Map<string, string | null>()

  const prefixMatch = (id: string): string | null => {
    const found = keys.filter((k) => k === id || k.startsWith(`${id}-`))
    if (found.length === 0) return null
    return found.includes(id) ? id : pickNewest(found)
  }

  const lookup = (model: string): string | null => {
    if (models[model]) return model
    const id = normalizeModelId(model)
    if (models[id]) return id
    const undated = id.replace(DATE_SUFFIX, '')
    if (models[undated]) return undated
    // Family fallback: drop trailing segments until a catalog prefix matches.
    const parts = undated.split('-')
    if (parts[0] !== 'claude') return null
    for (let n = parts.length; n >= MIN_FAMILY_SEGMENTS; n--) {
      const hit = prefixMatch(parts.slice(0, n).join('-'))
      if (hit) return hit
    }
    return null
  }

  const resolve = (model: string): string | null => {
    if (!memo.has(model)) memo.set(model, lookup(model))
    return memo.get(model) ?? null
  }

  const cost = (model: string, t: PricedTokens): number => {
    const key = resolve(model)
    if (!key) return 0
    const r = models[key]
    const input = r.input_cost_per_token ?? 0
    const prompt = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
    const long = prompt > LONG_CONTEXT_THRESHOLD
    const pick = (base: number | undefined, above: number | undefined): number =>
      (long ? (above ?? base) : base) ?? 0
    const inputRate = pick(input, r.input_cost_per_token_above_200k_tokens)
    const write1h = long
      ? (r.cache_creation_input_token_cost_above_1hr_above_200k_tokens ??
        inputRate * CACHE_WRITE_1H_INPUT_MULTIPLIER)
      : (r.cache_creation_input_token_cost_above_1hr ?? input * CACHE_WRITE_1H_INPUT_MULTIPLIER)
    return (
      t.input * inputRate +
      t.output * pick(r.output_cost_per_token, r.output_cost_per_token_above_200k_tokens) +
      t.cacheWrite5m *
        pick(
          r.cache_creation_input_token_cost,
          r.cache_creation_input_token_cost_above_200k_tokens
        ) +
      t.cacheWrite1h * write1h +
      t.cacheRead *
        pick(r.cache_read_input_token_cost, r.cache_read_input_token_cost_above_200k_tokens)
    )
  }

  return { resolve, cost }
}

/** Bundled LiteLLM snapshot; no network at runtime. */
export const defaultPricing: Pricing = createPricing(snapshot.models as Record<string, RawRates>)
