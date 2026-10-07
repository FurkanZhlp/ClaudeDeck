import { descendants, type ProcessInfo } from '../platform/processList'

/**
 * Claude Code runs a Bash command as `$SHELL -c source …/shell-snapshots/snapshot-….sh … &&
 * eval '<cmd>' …`: a child of claude leading its own process group (spike, 2.1.282).
 */
const SNAPSHOT = /shell-snapshots[\\/]snapshot-/
const EVAL = "eval '"
/** `'` inside the eval'd single-quoted command, as POSIX and as Windows command lines show it. */
const QUOTED_QUOTE = /'"'"'|'\\"'\\"'/g

export const isSnapshotWrapper = (command: string): boolean =>
  SNAPSHOT.test(command) && command.includes(EVAL)

/** The wrapper's command line with the eval quoting undone. */
export const unquoteWrapper = (command: string): string => command.replace(QUOTED_QUOTE, "'")

/** What identifies a run's processes. */
export interface RunFingerprint {
  /** The command exactly as Claude sent it. */
  command: string
  /** Runner tokens (`['pnpm', 'test']`, `['vitest']`); may be empty. */
  tokens: string[]
}

const EXTENSIONS = /\.(exe|cmd|bat|js|mjs|cjs)$/i

/** Lower-cased base names of a command line's words: `/x/node_modules/.bin/vitest` → `vitest`. */
function words(command: string): string[] {
  return command
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .replace(/^["']|["']$/g, '')
        .split(/[\\/]/)
        .pop()!
        .replace(EXTENSIONS, '')
        .toLowerCase()
    )
}

/** The tokens appear in order, side by side. */
function hasSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  const lowered = needle.map((t) => t.toLowerCase())
  for (let i = 0; i + lowered.length <= haystack.length; i++) {
    if (lowered.every((t, j) => haystack[i + j] === t)) return true
  }
  return false
}

/** How a run's processes were found: its snapshot wrapper, or its runner tokens only. */
export type MatchKind = 'wrapper' | 'tokens'

export interface RunMatch {
  kind: MatchKind
  processes: ProcessInfo[]
}

/** The run's eval'd command, closing quote included, so `pnpm test` never matches `pnpm test:e2e`. */
function wrapperHas(command: string, raw: string): boolean {
  const text = unquoteWrapper(command)
  const trimmed = raw.trim()
  return text.includes(`${EVAL}${raw}'`) || text.includes(`${EVAL}${trimmed}'`)
}

/**
 * Process trees under `rootPid` (the tab's pty) that belong to the run: snapshot wrappers whose
 * eval'd text is the command, or else the topmost processes whose command line carries the
 * runner tokens. Several results mean the run cannot be told apart from another one.
 */
export function findRunProcesses(
  list: ProcessInfo[],
  rootPid: number,
  run: RunFingerprint
): RunMatch {
  const tree = descendants(list, rootPid)
  if (run.command.trim()) {
    const wrappers = tree.filter(
      (p) => isSnapshotWrapper(p.command) && wrapperHas(p.command, run.command)
    )
    if (wrappers.length > 0) return { kind: 'wrapper', processes: wrappers }
  }
  const matches = tree.filter(
    (p) => !isSnapshotWrapper(p.command) && hasSequence(words(p.command), run.tokens)
  )
  const matched = new Set(matches.map((p) => p.pid))
  const parent = new Map(list.map((p) => [p.pid, p.ppid]))
  const hasMatchedAncestor = (p: ProcessInfo): boolean => {
    let pid = parent.get(p.pid)
    const seen = new Set<number>()
    while (pid !== undefined && pid !== rootPid && !seen.has(pid)) {
      if (matched.has(pid)) return true
      seen.add(pid)
      pid = parent.get(pid)
    }
    return false
  }
  return { kind: 'tokens', processes: matches.filter((p) => !hasMatchedAncestor(p)) }
}

/** True while a process with this pid is listed. */
export const isListed = (list: ProcessInfo[], pid: number): boolean =>
  list.some((p) => p.pid === pid)

/** `ps -o lstart` has whole seconds; a process started in the run's second still counts. */
export const START_TOLERANCE_MS = 1000

/** What stopProcess kills, and how it recognises that process again before escalating. */
export interface StopTarget {
  /** POSIX: the process group (and its leader's pid); Windows: the process for taskkill /T. */
  pid: number
  /** Command line and start time of that process, as listed. */
  command: string
  startMs: number
}

/** Started after the run was let through (so it cannot be an older process or a reused pid). */
const startedAfter = (
  p: ProcessInfo,
  runStartedAt: number
): p is ProcessInfo & { startMs: number } =>
  p.startMs !== null && p.startMs > runStartedAt - START_TOLERANCE_MS

/**
 * What to kill for a run, or null when that is not clearly safe.
 *
 * - POSIX: only a snapshot wrapper match counts; its process group is killed, so the group must
 *   be led by a process of this tab's tree that is not the tab itself, and the leader must have
 *   started after the run did.
 * - Windows (no groups): the matched process for `taskkill /T`, never claude itself and never a
 *   direct child of claude that is not a snapshot wrapper (MCP servers are claude's children).
 */
export function stopTarget(
  match: RunMatch,
  list: ProcessInfo[],
  rootPid: number,
  runStartedAt: number
): StopTarget | null {
  if (match.processes.length !== 1) return null
  const [target] = match.processes
  if (target.pid === rootPid || target.pid <= 1) return null
  if (target.pgid === null) {
    if (target.ppid === rootPid && !isSnapshotWrapper(target.command)) return null
    if (!startedAfter(target, runStartedAt)) return null
    return { pid: target.pid, command: target.command, startMs: target.startMs }
  }
  if (match.kind !== 'wrapper') return null
  const root = list.find((p) => p.pid === rootPid)
  const protectedGroups = new Set([rootPid, ...(root?.pgid != null ? [root.pgid] : [])])
  if (target.pgid <= 1 || protectedGroups.has(target.pgid)) return null
  // Only a group led by a process of this tab's tree may be killed.
  const leader = list.find((p) => p.pid === target.pgid)
  if (!leader) return null
  const inTree =
    leader.pid === target.pid || descendants(list, rootPid).some((p) => p.pid === leader.pid)
  if (!inTree || !startedAfter(leader, runStartedAt)) return null
  return { pid: leader.pid, command: leader.command, startMs: leader.startMs }
}
