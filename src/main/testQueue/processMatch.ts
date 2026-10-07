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

/**
 * Process trees under `rootPid` (the tab's pty) that belong to the run: snapshot wrappers whose
 * eval'd text contains the command, or else the topmost processes whose command line carries
 * the runner tokens. Several results mean the run cannot be told apart from another one.
 */
export function findRunProcesses(
  list: ProcessInfo[],
  rootPid: number,
  run: RunFingerprint
): ProcessInfo[] {
  const tree = descendants(list, rootPid)
  const command = run.command.trim()
  if (command) {
    const wrappers = tree.filter(
      (p) => isSnapshotWrapper(p.command) && unquoteWrapper(p.command).includes(command)
    )
    if (wrappers.length > 0) return wrappers
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
  return matches.filter((p) => !hasMatchedAncestor(p))
}

/** True while a process with this pid is listed. */
export const isListed = (list: ProcessInfo[], pid: number): boolean =>
  list.some((p) => p.pid === pid)

/**
 * The pid to hand to killTree for a match: its process group on POSIX (the wrapper leads one),
 * the process itself on Windows (taskkill /T). Null when killing it would reach the tab itself.
 */
export function stopTarget(
  match: ProcessInfo,
  list: ProcessInfo[],
  rootPid: number
): number | null {
  if (match.pid === rootPid) return null
  if (match.pgid === null) return match.pid
  const root = list.find((p) => p.pid === rootPid)
  const protectedGroups = new Set([rootPid, ...(root?.pgid != null ? [root.pgid] : [])])
  if (match.pgid <= 1 || protectedGroups.has(match.pgid)) return null
  // Only a group led by a process of this tab's tree may be killed.
  const leader = list.find((p) => p.pid === match.pgid)
  if (!leader) return null
  const inTree =
    leader.pid === match.pid || descendants(list, rootPid).some((p) => p.pid === leader.pid)
  return inTree ? match.pgid : null
}
