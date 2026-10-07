import { lstat, readdir, realpath } from 'node:fs/promises'
import { watch as fsWatch, type FSWatcher, type Stats } from 'node:fs'
import { DomainError } from '../../shared/errors'
import type { AgentEvent, AgentOpenResult, AgentSummary } from '../../shared/types'
import { isWithin } from '../platform/paths'
import {
  createTail,
  nextLineStart,
  openRegularFile,
  readLinesBefore,
  readNewLines,
  type JsonlLine,
  type TailState
} from '../transcripts/jsonlTail'
import {
  parseSessionLine,
  watchSessionTranscript,
  type SessionTranscriptEvent
} from '../transcripts/sessionTranscript'
import {
  agentFiles,
  agentIdOfFile,
  isSafeId,
  sessionTranscriptFile,
  subagentsDirIn,
  type AgentFiles,
  type SessionLocation
} from './subagentPaths'
import {
  applyActivity,
  buildSummary,
  createActivity,
  lineEvents,
  parseAgentMeta,
  type AgentActivity,
  type AgentMeta
} from './transcriptParse'

/** At most this many agents (the most recently started) are tracked per session. */
export const MAX_AGENTS = 100
/** Summary mode reads this much of each transcript's end before tailing it. */
export const SUMMARY_TAIL_BYTES = 64 * 1024
/** Byte window per page of the open agent's transcript. */
export const PAGE_BYTES = 256 * 1024
/** Events kept for the open agent (ring buffer) and per page. */
export const MAX_EVENTS = 1000
/** The parent transcript's end scanned for completions that happened before watching. */
const PARENT_SCAN_BYTES = 1024 * 1024
const MAX_SIGNALS = 2000
const META_MAX_BYTES = 64 * 1024
const MAX_PAGE_STEPS = 16

export interface WatcherTiming {
  /** Retry interval while the session's folders do not exist yet. */
  resolveMs: number
  /** Fallback scan while an agent runs. */
  activeScanMs: number
  /** Fallback scan otherwise (new agents usually arrive through fs.watch). */
  idleScanMs: number
  /** fs.watch debounce. */
  debounceMs: number
  parentPollMs: number
}

const DEFAULT_TIMING: WatcherTiming = {
  resolveMs: 2000,
  activeScanMs: 1000,
  idleScanMs: 5000,
  debounceMs: 150,
  parentPollMs: 2000
}

export type { SessionLocation }

export interface AgentWatcherOptions {
  /** Null while the tab has no Claude session id yet; called again until it resolves. */
  locate: () => SessionLocation | null
  /** Summaries may have changed (the caller debounces and compares). */
  onChange: () => void
  /** New events of the open agent, oldest first. */
  onEvents: (agentId: string, events: AgentEvent[]) => void
  queuedRunId?: (agentId: string) => string | undefined
  now?: () => number
  timing?: Partial<WatcherTiming>
  /** fs.watch for low latency; polling alone when false. */
  watchFiles?: boolean
}

/** Bounded insertion-ordered map: the oldest keys go first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_SIGNALS) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** Completion facts collected from the parent transcript and from agents' own transcripts. */
class CompletionSignals {
  private readonly done = new Map<string, number>()
  private readonly launchedAsync = new Map<string, true>()
  private readonly models = new Map<string, string>()

  private mark(key: string, at: number): void {
    remember(this.done, key, Math.max(at, this.done.get(key) ?? 0))
  }

  apply(event: SessionTranscriptEvent): void {
    if (event.type === 'taskNotification') {
      // A background agent's task id is its agent id; the notice may repeat (idempotent).
      this.mark(`task:${event.taskId}`, event.at)
      this.mark(`tool:${event.toolUseId}`, event.at)
      return
    }
    const agent = event.agentResult
    if (agent?.resolvedModel) remember(this.models, event.toolUseId, agent.resolvedModel)
    if (agent?.status === 'async_launched') {
      remember(this.launchedAsync, event.toolUseId, true)
    } else if (agent || event.isError) {
      // Foreground Agent call finished (or failed); other tools' results are not needed.
      this.mark(`tool:${event.toolUseId}`, event.at)
    }
  }

  doneAt(agentId: string, toolUseId: string | null): number | null {
    const byTask = this.done.get(`task:${agentId}`)
    const byTool = toolUseId ? this.done.get(`tool:${toolUseId}`) : undefined
    if (byTask === undefined && byTool === undefined) return null
    return Math.max(byTask ?? 0, byTool ?? 0)
  }

  isAsync(toolUseId: string | null): boolean {
    return !!toolUseId && this.launchedAsync.has(toolUseId)
  }

  resolvedModel(toolUseId: string | null): string | null {
    return (toolUseId && this.models.get(toolUseId)) || null
  }
}

interface AgentRecord {
  id: string
  files: AgentFiles
  meta: AgentMeta | null
  metaMtime: number
  createdAt: number
  modifiedAt: number
  tail: TailState | null
  activity: AgentActivity
}

interface RingEntry {
  /** Byte offset of the line the event comes from. */
  offset: number
  event: AgentEvent
}

interface OpenState {
  agentId: string
  loading: boolean
  ring: RingEntry[]
  /** Events read while the first page loads; delivered with it instead of through onEvents. */
  pending: RingEntry[]
  cursor: number | null
}

interface Located {
  parentFile: string
  subDir: string
}

/** Links are not followed: a planted symlink never reveals another file's times. */
const statOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

/** The real path of `path` lies inside the real path of `root`. */
async function realWithin(path: string, root: string): Promise<boolean> {
  try {
    const [real, realRoot] = await Promise.all([realpath(path), realpath(root)])
    return isWithin(real, realRoot)
  } catch {
    return false
  }
}

const createdTime = (s: Stats | null): number =>
  s ? (s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs) : Number.POSITIVE_INFINITY

const toEntries = (lines: JsonlLine[]): RingEntry[] =>
  lines.flatMap((line) => lineEvents(line).map((event) => ({ offset: line.offset, event })))

/** Keeps the newest `max` entries, dropping whole lines so a page never starts mid-line. */
function trimToLines(entries: RingEntry[], max: number): RingEntry[] {
  if (entries.length <= max) return entries
  let from = entries.length - max
  const boundary = entries[from - 1].offset
  while (from < entries.length && entries[from].offset === boundary) from++
  return entries.slice(from)
}

async function readMeta(path: string): Promise<AgentMeta | null> {
  const fh = await openRegularFile(path)
  if (!fh) return null
  try {
    if ((await fh.stat()).size > META_MAX_BYTES) return null
    return parseAgentMeta(JSON.parse(await fh.readFile('utf8')))
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * Watches one tab's subagents: summaries of every agent (meta + transcript end, then tailed) and
 * the full transcript of at most one open agent. Never creates folders.
 */
export class AgentSessionWatcher {
  private readonly timing: WatcherTiming
  private readonly now: () => number
  private located: Located | null = null
  private projectsRoot = ''
  private records = new Map<string, AgentRecord>()
  private signals = new CompletionSignals()
  private openState: OpenState | null = null
  private stopParent: (() => void) | null = null
  private dirWatcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private scanning: Promise<void> | null = null
  private rescan = false
  /** Bumped by suspend/dispose so scans in flight drop their results. */
  private generation = 0
  private disposed = false

  constructor(private readonly opts: AgentWatcherOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing }
    this.now = opts.now ?? Date.now
  }

  /** First scan, then periodic and fs.watch driven updates. */
  async start(): Promise<void> {
    await this.scan()
    this.schedule()
  }

  summaries(): AgentSummary[] {
    const now = this.now()
    return [...this.records.values()]
      .map((rec) => {
        const toolUseId = rec.meta?.toolUseId ?? null
        return buildSummary({
          agentId: rec.id,
          meta: rec.meta,
          activity: rec.activity,
          createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : now,
          modifiedAt: rec.modifiedAt,
          doneAt: this.signals.doneAt(rec.id, toolUseId),
          launchedAsync: this.signals.isAsync(toolUseId),
          resolvedModel: this.signals.resolvedModel(toolUseId),
          now,
          queuedRunId: this.opts.queuedRunId?.(rec.id)
        })
      })
      .sort((a, b) => a.startedAt - b.startedAt || a.agentId.localeCompare(b.agentId))
  }

  /** Full mode for one agent (replaces the previously open one): latest page, then live events. */
  async open(agentId: string): Promise<AgentOpenResult> {
    if (!isSafeId(agentId)) throw new DomainError('INVALID')
    const current = this.openState
    if (current && current.agentId === agentId && !current.loading) {
      return { events: current.ring.map((e) => e.event), cursor: current.cursor }
    }
    await this.scan()
    // Pick the boundary while no scan runs, so every later line arrives through the tail.
    while (this.scanning) await this.scanning
    const rec = this.records.get(agentId)
    if (!rec) throw new DomainError('NOT_FOUND')
    const state: OpenState = { agentId, loading: true, ring: [], pending: [], cursor: null }
    this.openState = state
    const end = rec.tail ? nextLineStart(rec.tail) : 0
    const page =
      end > 0 ? await this.readPage(rec.files.transcript, end) : { entries: [], cursor: null }
    const ring = trimToLines([...page.entries, ...state.pending], MAX_EVENTS)
    const trimmed = ring.length > 0 && ring.length < page.entries.length + state.pending.length
    const cursor = trimmed ? ring[0].offset : page.cursor
    if (this.openState === state) {
      state.ring = ring
      state.cursor = cursor
      state.pending = []
      state.loading = false
    }
    return { events: ring.map((e) => e.event), cursor }
  }

  close(agentId: string): void {
    if (this.openState?.agentId === agentId) this.openState = null
  }

  /** The page before `cursor` (a line start returned by open/older). */
  async older(agentId: string, cursor: number): Promise<AgentOpenResult> {
    if (!isSafeId(agentId)) throw new DomainError('INVALID')
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError('INVALID')
    const rec = this.records.get(agentId)
    if (!rec) throw new DomainError('NOT_FOUND')
    if (cursor === 0) return { events: [], cursor: null }
    const page = await this.readPage(rec.files.transcript, cursor)
    return { events: page.entries.map((e) => e.event), cursor: page.cursor }
  }

  /**
   * Closes every file handle and forgets what was read; the session is located again on the
   * next tick (Windows: before the account folder is removed or a project moves).
   */
  suspend(): void {
    this.generation++
    this.closeHandles()
    this.located = null
    this.records = new Map()
    this.signals = new CompletionSignals()
    this.openState = null
    this.opts.onChange()
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.closeHandles()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.records.clear()
    this.openState = null
  }

  private closeHandles(): void {
    this.stopParent?.()
    this.stopParent = null
    this.dirWatcher?.close()
    this.dirWatcher = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
  }

  private schedule(): void {
    if (this.disposed) return
    const running = this.located && this.summaries().some((s) => s.status === 'running')
    const delay = !this.located
      ? this.timing.resolveMs
      : running
        ? this.timing.activeScanMs
        : this.timing.idleScanMs
    this.timer = setTimeout(() => {
      void this.scan().then(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }

  private scan(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.scanning) {
      this.rescan = true
      return this.scanning
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescan = false
          await this.scanOnce()
        } while (this.rescan && !this.disposed)
      } catch (error) {
        console.warn('[agents] scan failed', error)
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  private async locate(): Promise<Located | null> {
    if (this.located) return this.located
    let location: SessionLocation | null
    try {
      location = this.opts.locate()
    } catch {
      location = null
    }
    if (!location || !isSafeId(location.claudeSessionId)) return null
    const gen = this.generation
    for (const dir of location.projectDirs) {
      const parentFile = sessionTranscriptFile(dir, location.claudeSessionId)
      const subDir = subagentsDirIn(dir, location.claudeSessionId)
      const found = (await statOrNull(parentFile)) || (await statOrNull(subDir))
      if (gen !== this.generation) return null
      if (!found) continue
      // A project folder linked to somewhere outside the account's projects is not read.
      const inside = await realWithin(dir, location.projectsRoot)
      if (gen !== this.generation) return null
      if (!inside) continue
      this.projectsRoot = location.projectsRoot
      this.located = { parentFile, subDir }
      this.stopParent = watchSessionTranscript(
        parentFile,
        (event) => {
          this.signals.apply(event)
          this.opts.onChange()
        },
        {
          initialScanBytes: PARENT_SCAN_BYTES,
          pollMs: this.timing.parentPollMs,
          watch: this.opts.watchFiles ?? true
        }
      )
      return this.located
    }
    return null
  }

  private startDirWatcher(dir: string): void {
    if (this.dirWatcher || this.opts.watchFiles === false) return
    try {
      const watcher = fsWatch(dir, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          this.debounce = null
          void this.scan()
        }, this.timing.debounceMs)
      })
      watcher.on('error', () => {
        watcher.close()
        if (this.dirWatcher === watcher) this.dirWatcher = null
      })
      this.dirWatcher = watcher
    } catch {
      this.dirWatcher = null
    }
  }

  private async scanOnce(): Promise<void> {
    const gen = this.generation
    const located = await this.locate()
    if (!located || gen !== this.generation) return
    let names: string[]
    try {
      if (!(await realWithin(located.subDir, this.projectsRoot))) throw new Error('outside')
      names = await readdir(located.subDir)
    } catch {
      this.opts.onChange()
      return
    }
    if (gen !== this.generation) return
    this.startDirWatcher(located.subDir)

    const ids = new Set<string>()
    for (const name of names) {
      const id = agentIdOfFile(name)
      if (id) ids.add(id)
    }
    const found = await Promise.all(
      [...ids].map(async (id) => {
        const files = agentFiles(located.subDir, id)
        const [metaStat, fileStat] = await Promise.all([
          statOrNull(files.meta),
          statOrNull(files.transcript)
        ])
        return {
          id,
          files,
          metaMtime: metaStat?.mtimeMs ?? 0,
          createdAt: Math.min(createdTime(metaStat), createdTime(fileStat)),
          modifiedAt: Math.max(metaStat?.mtimeMs ?? 0, fileStat?.mtimeMs ?? 0)
        }
      })
    )
    if (gen !== this.generation) return
    const kept = found.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_AGENTS)
    const keptIds = new Set(kept.map((k) => k.id))
    for (const id of [...this.records.keys()]) {
      if (!keptIds.has(id)) this.records.delete(id)
    }
    for (const entry of kept) {
      let rec = this.records.get(entry.id)
      if (!rec) {
        rec = {
          id: entry.id,
          files: entry.files,
          meta: null,
          metaMtime: -1,
          createdAt: entry.createdAt,
          modifiedAt: entry.modifiedAt,
          tail: null,
          activity: createActivity()
        }
        this.records.set(entry.id, rec)
      }
      rec.createdAt = entry.createdAt
      rec.modifiedAt = entry.modifiedAt
      if (entry.metaMtime !== rec.metaMtime) {
        rec.meta = (await readMeta(entry.files.meta)) ?? rec.meta
        rec.metaMtime = entry.metaMtime
      }
      await this.readAgent(rec, gen)
      if (gen !== this.generation) return
    }
    this.opts.onChange()
  }

  private async readAgent(rec: AgentRecord, gen: number): Promise<void> {
    if (!rec.tail) {
      if (!(await statOrNull(rec.files.transcript))) return
      const page = await readLinesBefore(
        rec.files.transcript,
        Number.MAX_SAFE_INTEGER,
        SUMMARY_TAIL_BYTES
      )
      if (gen !== this.generation) return
      rec.tail = createTail(page.end)
      rec.activity.partial = page.start !== null
      this.applyLines(rec, page.lines, false)
    }
    const lines = await readNewLines(rec.files.transcript, rec.tail)
    if (gen !== this.generation) return
    this.applyLines(rec, lines, true)
  }

  private applyLines(rec: AgentRecord, lines: JsonlLine[], live: boolean): void {
    if (lines.length === 0) return
    for (const line of lines) {
      applyActivity(rec.activity, line.value)
      // Agents started by this agent report completion in this transcript.
      for (const event of parseSessionLine(line.value)) this.signals.apply(event)
    }
    const open = this.openState
    if (!live || !open || open.agentId !== rec.id) return
    const entries = toEntries(lines)
    if (entries.length === 0) return
    if (open.loading) {
      open.pending.push(...entries)
      return
    }
    const before = open.ring.length
    open.ring = trimToLines([...open.ring, ...entries], MAX_EVENTS)
    if (open.ring.length < before + entries.length && open.ring.length > 0) {
      open.cursor = open.ring[0].offset
    }
    this.opts.onEvents(
      rec.id,
      entries.map((e) => e.event)
    )
  }

  private async readPage(
    file: string,
    end: number
  ): Promise<{ entries: RingEntry[]; cursor: number | null }> {
    let before = end
    for (let step = 0; step < MAX_PAGE_STEPS; step++) {
      const page = await readLinesBefore(file, before, PAGE_BYTES)
      const entries = toEntries(page.lines)
      if (entries.length > 0 || page.start === null || page.start >= before) {
        const kept = trimToLines(entries, MAX_EVENTS)
        const cursor = kept.length < entries.length && kept.length > 0 ? kept[0].offset : page.start
        return { entries: kept, cursor }
      }
      before = page.start
    }
    return { entries: [], cursor: before }
  }
}
