import { watch as fsWatch } from 'node:fs'

/** Folder watching for the hook files; tests pass fakes. */
export interface WatchFs {
  /** Calls `onChange` with the changed entry's name (null when unknown); null if unwatchable. */
  watch(dir: string, onChange: (name: string | null) => void): { close(): void } | null
}

export const nodeWatchFs: WatchFs = {
  watch(dir, onChange) {
    try {
      const watcher = fsWatch(dir, { persistent: false }, (_event, name) =>
        onChange(name ? String(name) : null)
      )
      watcher.on('error', () => watcher.close())
      return watcher
    } catch {
      return null
    }
  }
}

/** A set of folder watchers keyed by id, replaced as a whole when the wanted folders change. */
export interface WatchGroup {
  /** Watches exactly `dirs`; folders no longer listed are released. */
  set(dirs: ReadonlyMap<string, (name: string | null) => void>): void
  close(): void
}

export function createWatchGroup(fs: WatchFs): WatchGroup {
  const open = new Map<string, { close(): void } | null>()
  const handlers = new Map<string, (name: string | null) => void>()
  const close = (dir: string): void => {
    try {
      open.get(dir)?.close()
    } catch {
      // Already closed.
    }
    open.delete(dir)
    handlers.delete(dir)
  }
  return {
    set(dirs) {
      for (const dir of [...open.keys()]) if (!dirs.has(dir)) close(dir)
      for (const [dir, onChange] of dirs) {
        handlers.set(dir, onChange)
        // A folder that could not be watched (missing) is tried again on the next set.
        if (open.get(dir)) continue
        open.set(
          dir,
          fs.watch(dir, (name) => handlers.get(dir)?.(name))
        )
      }
    },
    close() {
      for (const dir of [...open.keys()]) close(dir)
    }
  }
}
