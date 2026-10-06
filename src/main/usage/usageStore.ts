import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { AccountUsage, UsageWindow } from '../../shared/types'
import { writeFileAtomic } from '../profile/guidelines'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** One statusline window (`used_percentage`, `resets_at` in epoch seconds); null if malformed. */
function parseWindow(raw: unknown): UsageWindow | null {
  if (!isObject(raw) || !isNumber(raw.used_percentage) || !isNumber(raw.resets_at)) return null
  if (raw.resets_at <= 0) return null
  return {
    usedPercentage: Math.min(100, Math.max(0, raw.used_percentage)),
    resetsAt: Math.round(raw.resets_at * 1000)
  }
}

/** Usage from the JSON Claude Code feeds its statusline; null when no window is present. */
export function parseStatuslineUsage(
  json: unknown,
  accountId: string,
  now: number
): AccountUsage | null {
  if (!isObject(json) || !isObject(json.rate_limits)) return null
  const fiveHour = parseWindow(json.rate_limits.five_hour)
  const sevenDay = parseWindow(json.rate_limits.seven_day)
  if (!fiveHour && !sevenDay) return null
  return { accountId, fiveHour, sevenDay, updatedAt: now }
}

const isWindow = (v: unknown): v is UsageWindow =>
  isObject(v) && isNumber(v.usedPercentage) && isNumber(v.resetsAt)

const isModelWindow = (v: unknown): boolean =>
  isWindow(v) && typeof (v as unknown as Json).model === 'string'

const isUsage = (v: unknown): v is AccountUsage =>
  isObject(v) &&
  typeof v.accountId === 'string' &&
  isNumber(v.updatedAt) &&
  (v.fiveHour === null || isWindow(v.fiveHour)) &&
  (v.sevenDay === null || isWindow(v.sevenDay)) &&
  (v.models === undefined || (Array.isArray(v.models) && v.models.every(isModelWindow)))

export interface UsageStore {
  get(accountId: string): AccountUsage | null
  list(): AccountUsage[]
  /** Keeps the reading unless an equal or newer one is stored; true when it was taken. */
  update(usage: AccountUsage): boolean
  /** Forgets accounts not in `accountIds`. */
  retain(accountIds: Iterable<string>): void
}

/** Last known usage per account, in memory and persisted to `file` (atomic writes). */
export function createUsageStore(file: string): UsageStore {
  const byAccount = new Map<string, AccountUsage>()
  try {
    if (existsSync(file)) {
      const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const items = isObject(json) && Array.isArray(json.accounts) ? json.accounts : []
      for (const item of items) if (isUsage(item)) byAccount.set(item.accountId, item)
    }
  } catch (error) {
    // Only a cache; a broken file is replaced on the next save.
    console.warn('[usage] could not read stored usage', error)
  }

  const save = (): void => {
    try {
      const data = { version: 1, accounts: [...byAccount.values()] }
      writeFileAtomic(file, JSON.stringify(data, null, 2), 0o600)
    } catch (error) {
      console.warn('[usage] could not save usage', error)
    }
  }

  return {
    get: (accountId) => byAccount.get(accountId) ?? null,
    list: () => [...byAccount.values()],
    update(usage) {
      const existing = byAccount.get(usage.accountId)
      if (existing && existing.updatedAt > usage.updatedAt) return false
      if (existing && isDeepStrictEqual(existing, usage)) return false
      byAccount.set(usage.accountId, usage)
      save()
      return true
    },
    retain(accountIds) {
      const keep = new Set(accountIds)
      let removed = false
      for (const id of [...byAccount.keys()]) {
        if (!keep.has(id)) {
          byAccount.delete(id)
          removed = true
        }
      }
      if (removed) save()
    }
  }
}
