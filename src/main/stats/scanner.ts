// Ported from OpenUsage's ClaudeLogUsageScanner (MIT, robinebers/openusage), itself a port of
// ccusage's Claude adapter: usage lines from `<configDir>/projects/**/*.jsonl`, deduplicated by
// (message.id, requestId), cost mode "auto" (a line's costUSD, else tokens x model rates).
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { AccountStats, DailyUsage } from '../../shared/types'
import { defaultPricing, type PricedTokens, type Pricing } from './pricing'

export const DEFAULT_STATS_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Files untouched since this long before the window cannot hold entries inside it. */
const MTIME_MARGIN_MS = DAY_MS
const USAGE_MARKER = '"usage":{'
const SYNTHETIC_MODEL = '<synthetic>'

/** One usage line, priced at parse time (the pricing snapshot is fixed per scanner). */
export interface UsageEntry {
  timestamp: number
  /** `message.id` + `requestId`, or null when either is missing (never deduplicated). */
  key: string | null
  tokens: PricedTokens
  costUSD: number
}

interface CachedFile {
  size: number
  mtimeMs: number
  entries: UsageEntry[]
}

interface FileInfo {
  path: string
  size: number
  mtimeMs: number
}

export interface StatsScannerOptions {
  pricing?: Pricing
  /** Called for every file actually parsed (cache misses); for tests and diagnostics. */
  onParse?: (path: string) => void
}

export interface StatsScanner {
  scan(configDir: string, accountId: string, now: number, days?: number): Promise<AccountStats>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Local calendar day, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight of the first day of a `days` long window ending today. */
export function windowStart(now: number, days: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime()
}

export function parseUsageLine(line: string, pricing: Pricing): UsageEntry | null {
  if (!line.includes(USAGE_MARKER)) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(row) || typeof row.timestamp !== 'string') return null
  const timestamp = Date.parse(row.timestamp)
  if (Number.isNaN(timestamp)) return null
  const message = row.message
  if (!isObject(message) || !isObject(message.usage)) return null
  const usage = message.usage
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null

  // The 5m/1h split when present, else the aggregate counted as 5m writes.
  const split = isObject(usage.cache_creation) ? usage.cache_creation : null
  const tokens: PricedTokens = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite5m: split
      ? num(split.ephemeral_5m_input_tokens)
      : num(usage.cache_creation_input_tokens),
    cacheWrite1h: split ? num(split.ephemeral_1h_input_tokens) : 0,
    cacheRead: num(usage.cache_read_input_tokens)
  }
  if (split && tokens.cacheWrite5m + tokens.cacheWrite1h === 0) {
    tokens.cacheWrite5m = num(usage.cache_creation_input_tokens)
  }

  const model = typeof message.model === 'string' ? message.model : null
  let costUSD: number
  if (typeof row.costUSD === 'number' && Number.isFinite(row.costUSD)) costUSD = row.costUSD
  else if (model && model !== SYNTHETIC_MODEL) costUSD = pricing.cost(model, tokens)
  else costUSD = 0

  const id = typeof message.id === 'string' && message.id ? message.id : null
  const requestId = typeof row.requestId === 'string' && row.requestId ? row.requestId : null
  return { timestamp, key: id && requestId ? `${id}:${requestId}` : null, tokens, costUSD }
}

async function parseFile(path: string, pricing: Pricing): Promise<UsageEntry[]> {
  const entries: UsageEntry[] = []
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const entry = parseUsageLine(line, pricing)
      if (entry) entries.push(entry)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return entries
}

/** Every `*.jsonl` under `dir`, path-sorted so keep-first dedup is deterministic. Skips symlinks. */
async function listJsonl(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = join(current, item.name)
      if (item.isDirectory()) await walk(full)
      else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(full)
    }
  }
  await walk(dir)
  return out.sort()
}

function emptyDays(start: number, days: number): Map<string, DailyUsage> {
  const map = new Map<string, DailyUsage>()
  const s = new Date(start)
  for (let i = 0; i < days; i++) {
    const date = localDay(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i).getTime())
    map.set(date, {
      date,
      costUSD: 0,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    })
  }
  return map
}

export function createStatsScanner(options: StatsScannerOptions = {}): StatsScanner {
  const pricing = options.pricing ?? defaultPricing
  const cache = new Map<string, CachedFile>()

  const entriesOf = async (file: FileInfo): Promise<UsageEntry[]> => {
    const hit = cache.get(file.path)
    if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.entries
    options.onParse?.(file.path)
    const entries = await parseFile(file.path, pricing)
    cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, entries })
    return entries
  }

  return {
    async scan(configDir, accountId, now, days = DEFAULT_STATS_DAYS) {
      const start = windowStart(now, days)
      const root = join(configDir, 'projects')
      const files: FileInfo[] = []
      for (const path of await listJsonl(root)) {
        try {
          const s = await stat(path)
          if (s.mtimeMs >= start - MTIME_MARGIN_MS) {
            files.push({ path, size: s.size, mtimeMs: s.mtimeMs })
          }
        } catch {
          // Removed between listing and stat.
        }
      }

      // Forget files of this account that vanished or fell out of the window.
      const kept = new Set(files.map((f) => f.path))
      for (const path of cache.keys()) {
        if (path.startsWith(root + sep) && !kept.has(path)) cache.delete(path)
      }

      const byDay = emptyDays(start, days)
      const seen = new Set<string>()
      for (const file of files) {
        let entries: UsageEntry[]
        try {
          entries = await entriesOf(file)
        } catch (error) {
          console.warn('[stats] could not read', file.path, error)
          continue
        }
        for (const entry of entries) {
          if (entry.key) {
            if (seen.has(entry.key)) continue
            seen.add(entry.key)
          }
          if (entry.timestamp < start) continue
          const day = byDay.get(localDay(entry.timestamp))
          if (!day) continue
          day.costUSD += entry.costUSD
          day.tokens.input += entry.tokens.input
          day.tokens.output += entry.tokens.output
          day.tokens.cacheWrite += entry.tokens.cacheWrite5m + entry.tokens.cacheWrite1h
          day.tokens.cacheRead += entry.tokens.cacheRead
        }
      }
      return { accountId, days: [...byDay.values()], updatedAt: now }
    }
  }
}

const sharedScanner = createStatsScanner()

/** Daily token and API-equivalent cost totals from an account's local transcripts. Read-only. */
export function scanAccountStats(
  configDir: string,
  accountId: string,
  now: number,
  days = DEFAULT_STATS_DAYS
): Promise<AccountStats> {
  return sharedScanner.scan(configDir, accountId, now, days)
}
