// Rebuilds resources/pricing/claude-models.json from LiteLLM's public price list (Claude models only).
// Usage: pnpm pricing:update
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const [src, out] = process.argv.slice(2)
const d = JSON.parse(readFileSync(src, 'utf8'))
const FIELDS = [
  'input_cost_per_token','output_cost_per_token','cache_creation_input_token_cost','cache_read_input_token_cost',
  'cache_creation_input_token_cost_above_1hr','input_cost_per_token_above_200k_tokens','output_cost_per_token_above_200k_tokens',
  'cache_creation_input_token_cost_above_200k_tokens','cache_read_input_token_cost_above_200k_tokens',
  'cache_creation_input_token_cost_above_1hr_above_200k_tokens'
]
const rank = { anthropic: 0, bedrock: 1, bedrock_converse: 1, 'vertex_ai-anthropic_models': 2 }
const norm = (k) => {
  let id = k
  if (/^(us|eu|apac|au|jp|global|us-gov)\./.test(id)) return null // regional premium
  id = id.replace(/^(anthropic|bedrock|vertex_ai|bedrock\/[^/]+)\//, '').replace(/^anthropic\./, '')
  if (id.includes('/')) return null
  id = id.replace(/-v\d+(:\d+)?$/, '').replace(/@(\d{8})$/, '-$1').replace(/@.*$/, '')
  return /^claude-/.test(id) ? id : null
}
const best = {}
for (const [k, v] of Object.entries(d)) {
  if (!(v.litellm_provider in rank) || typeof v.input_cost_per_token !== 'number') continue
  const id = norm(k)
  if (!id) continue
  const r = rank[v.litellm_provider] + (k === id ? 0 : 0.5)
  if (best[id] && best[id].r <= r) continue
  const e = {}
  for (const f of FIELDS) if (typeof v[f] === 'number') e[f] = v[f]
  best[id] = { r, e }
}
const models = Object.fromEntries(Object.keys(best).sort().map((k) => [k, best[k].e]))
const doc = {
  _source: 'BerriAI/litellm model_prices_and_context_window.json (MIT), Anthropic Claude entries only; prefers the anthropic provider, then bedrock/vertex_ai (non-regional) for models no longer listed there',
  _fetchedAt: new Date().toISOString(),
  models
}
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
console.log(Object.keys(models).length, Object.keys(models).join(' '))
