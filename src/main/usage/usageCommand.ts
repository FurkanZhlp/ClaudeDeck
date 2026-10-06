import type { AccountUsage, ModelUsageWindow, UsageWindow } from '../../shared/types'

/** Arguments for the headless `/usage` run (no model call, no transcript). */
export const USAGE_COMMAND_ARGS = [
  '-p',
  '/usage',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--output-format',
  'json'
]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const FIVE_HOUR_MS = 5 * HOUR
export const SEVEN_DAY_MS = 7 * DAY

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const SESSION_LINE = /^\s*Current session:\s*(\d+(?:\.\d+)?)\s*%\s*used(.*)$/im
// "Current week:" or "Current week (all models):"; per-model lines are parsed separately.
const WEEK_LINE = /^\s*Current week(?:\s*\(all models\))?:\s*(\d+(?:\.\d+)?)\s*%\s*used(.*)$/im
const MODEL_LINE = /^\s*Current week\s*\(([^)]+)\):\s*(\d+(?:\.\d+)?)\s*%\s*used(.*)$/gim
const ALL_MODELS = /^all models$/i

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?`
const ZONE = String.raw`(?:\s*\(([^)]+)\))?`
const RESET_DATE = new RegExp(
  String.raw`resets\s+(?:on\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+at\s+${TIME})?${ZONE}`,
  'i'
)
const RESET_TIME = new RegExp(String.raw`resets\s+(?:at\s+)?${TIME}${ZONE}`, 'i')
const RESET_IN = /resets\s+in\s+((?:\d+\s*[dhm][a-z]*[\s,]*)+)/i

// ---- Zone-aware wall clock -> epoch conversion -------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(timeZone)
  if (f) return f
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
  } catch {
    return null
  }
  formatters.set(timeZone, f)
  return f
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(f: Intl.DateTimeFormat, at: number): WallClock {
  const parts: Record<string, number> = {}
  for (const p of f.formatToParts(at)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second
  }
}

/** Zone offset (ms, east positive) at the instant `at`. */
function offsetAt(f: Intl.DateTimeFormat, at: number): number {
  const w = wallClock(f, at)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(at / 1000) * 1000
}

/** Epoch ms of a wall clock time in `f`'s zone; day overflow is normalized like Date.UTC. */
function zonedToEpoch(
  f: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const local = Date.UTC(year, month - 1, day, hour, minute)
  const first = offsetAt(f, local)
  const guess = local - first
  const second = offsetAt(f, guess)
  // Around a DST switch the offset at the guess differs from the one at the naive instant.
  return second === first ? guess : local - second
}

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Formatter for the zone the text names, falling back to the system zone. */
function zoneFormatter(name: string | undefined): Intl.DateTimeFormat | null {
  return (name && formatter(name.trim())) || formatter(localZone())
}

function toHour(raw: string | undefined, ampm: string | undefined): number | null {
  if (raw === undefined) return 0
  const h = Number(raw)
  if (ampm) {
    if (h < 1 || h > 12) return null
    return (h % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0)
  }
  return h <= 23 ? h : null
}

function toMinute(raw: string | undefined): number | null {
  if (raw === undefined) return 0
  const m = Number(raw)
  return m <= 59 ? m : null
}

// ---- Reset parsing ----------------------------------------------------------------------

/** "resets Oct 9 at 4am (Europe/Istanbul)"; the year is the next fitting one. */
function parseDateReset(text: string, now: number): number | null {
  const m = RESET_DATE.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
  const day = Number(m[2])
  const hour = toHour(m[3], m[5])
  const minute = toMinute(m[4])
  const f = zoneFormatter(m[6])
  if (month < 1 || day < 1 || day > 31 || hour === null || minute === null || !f) return null
  const year = new Date(now).getUTCFullYear()
  for (const y of [year - 1, year, year + 1]) {
    const at = zonedToEpoch(f, y, month, day, hour, minute)
    if (at >= now - DAY) return at
  }
  return null
}

/** "resets 7:30am (Europe/Istanbul)": the next occurrence of that wall clock time. */
function parseTimeReset(text: string, now: number): number | null {
  const m = RESET_TIME.exec(text)
  // A bare number is not a time; require minutes or am/pm.
  if (!m || (m[2] === undefined && m[3] === undefined)) return null
  const hour = toHour(m[1], m[3])
  const minute = toMinute(m[2])
  const f = zoneFormatter(m[4])
  if (hour === null || minute === null || !f) return null
  const today = wallClock(f, now)
  for (const offset of [0, 1]) {
    const at = zonedToEpoch(f, today.year, today.month, today.day + offset, hour, minute)
    if (at >= now - MINUTE) return at
  }
  return null
}

/** "resets in 3h 20m". */
function parseRelativeReset(text: string, now: number): number | null {
  const m = RESET_IN.exec(text)
  if (!m) return null
  const unit: Record<string, number> = { d: DAY, h: HOUR, m: MINUTE }
  let total = 0
  for (const [, n, u] of m[1].matchAll(/(\d+)\s*([dhm])/gi))
    total += Number(n) * unit[u.toLowerCase()]
  return total > 0 ? now + total : null
}

export function parseResetsAt(text: string, now: number): number | null {
  return parseRelativeReset(text, now) ?? parseDateReset(text, now) ?? parseTimeReset(text, now)
}

function toWindow(percent: string, rest: string, windowMs: number, now: number): UsageWindow {
  return {
    usedPercentage: Math.min(100, Math.max(0, Number(percent))),
    // Unreadable reset: estimate a full window from now rather than drop the percentage.
    resetsAt: parseResetsAt(rest, now) ?? now + windowMs
  }
}

function parseLine(
  text: string,
  pattern: RegExp,
  windowMs: number,
  now: number
): UsageWindow | null {
  const m = pattern.exec(text)
  return m ? toWindow(m[1], m[2], windowMs, now) : null
}

/** "Current week (Fable): 0% used · resets ..." lines, except the all-models one. */
function parseModelLines(text: string, now: number): ModelUsageWindow[] {
  const models: ModelUsageWindow[] = []
  for (const m of text.matchAll(MODEL_LINE)) {
    const model = m[1].trim()
    if (!model || ALL_MODELS.test(model) || models.some((w) => w.model === model)) continue
    models.push({ model, ...toWindow(m[2], m[3], SEVEN_DAY_MS, now) })
  }
  return models
}

/** Usage from the text `claude -p /usage` prints; null when it has no plan windows. */
export function parseUsageCommandOutput(
  text: string,
  accountId: string,
  now: number
): AccountUsage | null {
  const fiveHour = parseLine(text, SESSION_LINE, FIVE_HOUR_MS, now)
  const sevenDay = parseLine(text, WEEK_LINE, SEVEN_DAY_MS, now)
  if (!fiveHour && !sevenDay) return null
  // Always set, even when empty: the poll is authoritative for per-model limits.
  return { accountId, fiveHour, sevenDay, models: parseModelLines(text, now), updatedAt: now }
}

/**
 * The `result` text of `--output-format json` stdout. Login shell rc files may print first,
 * so the last line holding a JSON object wins. Null for errors or missing output.
 */
export function usageResultText(stdout: string): string | null {
  const lines = stdout.split('\n')
  const candidates = lines.map((l) => l.trim()).filter((l) => l.startsWith('{'))
  // Pretty-printed output spans lines; try everything from the first brace as a last resort.
  const start = stdout.indexOf('{')
  if (start >= 0) candidates.unshift(stdout.slice(start))
  for (let i = candidates.length - 1; i >= 0; i--) {
    let json: unknown
    try {
      json = JSON.parse(candidates[i])
    } catch {
      continue
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) continue
    const msg = json as Record<string, unknown>
    if (msg.is_error === true || typeof msg.result !== 'string') return null
    return msg.result
  }
  return null
}
