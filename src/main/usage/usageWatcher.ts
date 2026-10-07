import { mkdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc'
import type { Account, AccountUsage } from '../../shared/types'
import { installStatusline, USAGE_RAW_FILE, usageDir } from './statusline'
import { createUsageStore, parseStatuslineUsage } from './usageStore'

const CHANGE_DEBOUNCE_MS = 200
// A reader can catch the file between truncate and write on file systems without atomic rename.
const PARSE_RETRY_MS = 50

interface Deps {
  repo: { get(): { accounts: Account[] } }
  userDataDir: string
  send: (channel: string, ...args: unknown[]) => void
  now?: () => number
}

/**
 * Statusline readings carry no per-model limits; they keep the account's last polled ones
 * while those windows have not reset yet.
 */
export function withKnownModels(
  reading: AccountUsage,
  previous: AccountUsage | null,
  now: number
): AccountUsage {
  if (reading.models !== undefined || !previous?.models) return reading
  const models = previous.models.filter((m) => m.resetsAt > now)
  return models.length > 0 ? { ...reading, models } : reading
}

interface Watch {
  accountId: string
  dir: string
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
}

export interface UsageService {
  /** Installs the statusline hook and watches the account's usage file. */
  prepareAccount(account: Account): void
  /** Stops watchers and forgets usage of accounts that no longer exist. */
  sync(accounts: Account[]): void
  /**
   * Closes the account's watcher and drops its usage. Call before moving or deleting the
   * account folder: an open watch handle blocks rename and rm on Windows.
   */
  forget(accountId: string): void
  /** Takes a reading from another source (the poller); the newest `updatedAt` wins. */
  ingest(usage: AccountUsage): void
  list(): AccountUsage[]
  dispose(): void
}

export function createUsageService({
  repo,
  userDataDir,
  send,
  now = Date.now
}: Deps): UsageService {
  const store = createUsageStore(join(userDataDir, 'usage.json'))
  const watches = new Map<string, Watch>()
  let disposed = false

  const stop = (entry: Watch): void => {
    entry.watcher?.close()
    entry.watcher = null
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  const take = (reading: AccountUsage): void => {
    const usage = withKnownModels(reading, store.get(reading.accountId), now())
    if (store.update(usage)) send(IPC.usageUpdate, usage)
  }

  const accept = (accountId: string, json: unknown, mtime: number): void => {
    const usage = parseStatuslineUsage(json, accountId, mtime)
    if (usage) take(usage)
  }

  const read = (entry: Watch, retry: boolean): void => {
    if (disposed || !watches.has(entry.accountId)) return
    const file = join(entry.dir, USAGE_RAW_FILE)
    let text: string
    let mtime: number
    try {
      mtime = Math.round(statSync(file).mtimeMs)
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      if (retry) setTimeout(() => read(entry, false), PARSE_RETRY_MS)
      return
    }
    accept(entry.accountId, json, mtime)
  }

  const schedule = (entry: Watch): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      read(entry, true)
    }, CHANGE_DEBOUNCE_MS)
  }

  const start = (entry: Watch): void => {
    stop(entry)
    try {
      mkdirSync(entry.dir, { recursive: true })
      const watcher = watch(entry.dir, (_event, name) => {
        // Events may name the temp file (or nothing) when coalesced; the read uses the final file.
        if (!name || name.startsWith(USAGE_RAW_FILE)) schedule(entry)
      })
      watcher.on('error', (error) => {
        console.warn('[usage] watcher stopped', entry.accountId, error)
        if (entry.watcher === watcher) stop(entry)
      })
      entry.watcher = watcher
    } catch (error) {
      console.warn('[usage] could not watch', entry.accountId, error)
    }
  }

  const sync = (accounts: Account[]): void => {
    const ids = new Set(accounts.map((a) => a.id))
    for (const [id, entry] of watches) {
      if (!ids.has(id)) {
        stop(entry)
        watches.delete(id)
      }
    }
    store.retain(ids)
  }

  const forget = (accountId: string): void => {
    const entry = watches.get(accountId)
    if (entry) stop(entry)
    watches.delete(accountId)
    store.retain(store.list().flatMap((u) => (u.accountId === accountId ? [] : [u.accountId])))
  }

  return {
    prepareAccount(account) {
      if (disposed) return
      const known = repo.get().accounts
      sync(known.some((a) => a.id === account.id) ? known : [...known, account])
      try {
        installStatusline(account.configDir)
      } catch (error) {
        console.warn('[usage] could not install statusline', account.id, error)
      }
      const dir = usageDir(account.configDir)
      let entry = watches.get(account.id)
      if (!entry) {
        entry = { accountId: account.id, dir, watcher: null, timer: null }
        watches.set(account.id, entry)
      }
      if (entry.dir !== dir || !entry.watcher) {
        entry.dir = dir
        start(entry)
      }
      // Picks up readings written while the app was closed (or before the watcher started).
      read(entry, true)
    },
    sync,
    forget,
    ingest(usage) {
      if (disposed) return
      if (!repo.get().accounts.some((a) => a.id === usage.accountId)) return
      take(usage)
    },
    list: () => store.list(),
    dispose() {
      disposed = true
      watches.forEach(stop)
      watches.clear()
    }
  }
}
