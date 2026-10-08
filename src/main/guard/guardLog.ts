import { randomUUID } from 'node:crypto'
import { GUARD_LIMITS } from '../../shared/guardLimits'
import type { GuardLogEntry } from '../../shared/types'

/** The last guard decisions with a matching rule, in memory only (never written to disk). */
export interface GuardLog {
  add(entry: Omit<GuardLogEntry, 'id' | 'at'>): GuardLogEntry
  /** Newest first. */
  list(): GuardLogEntry[]
  clear(): void
}

export function createGuardLog(
  opts: {
    size?: number
    onEntry?: (entry: GuardLogEntry) => void
    now?: () => number
    newId?: () => string
  } = {}
): GuardLog {
  const size = opts.size ?? GUARD_LIMITS.logSize
  const now = opts.now ?? Date.now
  const newId = opts.newId ?? randomUUID
  let entries: GuardLogEntry[] = []
  return {
    add(entry) {
      const full: GuardLogEntry = { id: newId(), at: now(), ...entry }
      entries = [full, ...entries].slice(0, size)
      try {
        opts.onEntry?.(full)
      } catch (error) {
        console.warn('[guard] log listener failed', error)
      }
      return full
    },
    list: () => [...entries],
    clear() {
      entries = []
    }
  }
}
