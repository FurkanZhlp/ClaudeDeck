import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Per-account guard keys: a random secret written next to the hook script, so a claude
 * process that lost the tab's env (no token) still has its tool calls checked. In memory
 * only besides that file; never logged. A new key replaces the old one on every hook sync; the
 * previous key stays valid until the next rotation, so a hook that read it just before keeps
 * working.
 */
export interface GuardKeys {
  /** A fresh key for the account (the previous one stays valid until the next rotation). */
  rotate(accountId: string): string
  /** The account a key belongs to, or null. */
  lookup(key: string): string | null
  forget(accountId: string): void
}

const KEY = /^[0-9a-f]{64}$/

export function createGuardKeys(
  newKey: () => string = () => randomBytes(32).toString('hex')
): GuardKeys {
  const keys = new Map<string, { current: Buffer; previous: Buffer | null }>()
  return {
    rotate(accountId) {
      const key = newKey()
      const before = keys.get(accountId)
      keys.set(accountId, { current: Buffer.from(key, 'utf8'), previous: before?.current ?? null })
      return key
    },
    lookup(key) {
      if (!KEY.test(key)) return null
      const given = Buffer.from(key, 'utf8')
      let found: string | null = null
      // Every key is compared (constant time each), so timing does not tell which one matched.
      for (const [accountId, { current, previous }] of keys) {
        const hit =
          timingSafeEqual(given, current) || (!!previous && timingSafeEqual(given, previous))
        if (hit) found = accountId
      }
      return found
    },
    forget(accountId) {
      keys.delete(accountId)
    }
  }
}
