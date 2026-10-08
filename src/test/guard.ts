import { evaluateGuard, type GuardContext } from '../main/guard/evaluate'
import { defaultGuardSettings } from '../main/state/guardSettings'
import type { GuardDecision, GuardSettings, ProjectGuard } from '../shared/types'

/**
 * Guard contexts for evaluator tables. Every test passes command STRINGS to the pure evaluator;
 * nothing is ever executed.
 */
export const CONTEXTS: Record<'mac' | 'linux' | 'win', GuardContext> = {
  mac: {
    os: 'darwin',
    home: '/Users/dev',
    cwd: '/Users/dev/projects/app',
    env: { HOME: '/Users/dev', TMPDIR: '/var/folders/xy/T/' },
    configDir: '/Users/dev/Library/Application Support/ClaudeDeck/accounts/a1',
    appDataDir: '/Users/dev/Library/Application Support/ClaudeDeck',
    settings: defaultGuardSettings(),
    gitBranch: 'feature/x'
  },
  linux: {
    os: 'linux',
    home: '/home/dev',
    cwd: '/home/dev/projects/app',
    env: { HOME: '/home/dev' },
    configDir: '/home/dev/.config/ClaudeDeck/accounts/a1',
    appDataDir: '/home/dev/.config/ClaudeDeck',
    settings: defaultGuardSettings(),
    gitBranch: 'feature/x'
  },
  win: {
    os: 'win32',
    home: 'C:\\Users\\dev',
    cwd: 'C:\\Users\\dev\\projects\\app',
    env: {
      USERPROFILE: 'C:\\Users\\dev',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp'
    },
    configDir: 'C:\\Users\\dev\\AppData\\Roaming\\ClaudeDeck\\accounts\\a1',
    appDataDir: 'C:\\Users\\dev\\AppData\\Roaming\\ClaudeDeck',
    settings: defaultGuardSettings(),
    gitBranch: 'feature/x'
  }
}

export type HostName = keyof typeof CONTEXTS

export function context(
  host: HostName,
  extra: Partial<GuardContext> & { settings?: GuardSettings; projectOverrides?: ProjectGuard } = {}
): GuardContext {
  return { ...CONTEXTS[host], ...extra }
}

/** Decision for a Bash (or other tool) call. */
export function decide(
  command: string,
  host: HostName = 'mac',
  tool = 'Bash',
  extra: Partial<GuardContext> = {}
): GuardDecision {
  const ctx = context(host, extra)
  const input = tool in FILE_KEYS ? { [FILE_KEYS[tool]]: command } : { command }
  return evaluateGuard(tool, input, ctx)
}

const FILE_KEYS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}

/** The deciding rule id, or null when nothing matched. */
export const ruleOf = (command: string, host: HostName = 'mac', tool = 'Bash'): string | null =>
  decide(command, host, tool).ruleId ?? null

/** Runs a table: each row is [input, expected rule id or null]. Returns mismatches. */
export function mismatches(
  rows: readonly (readonly [string, string | null])[],
  host: HostName = 'mac',
  tool = 'Bash'
): { input: string; expected: string | null; actual: string | null }[] {
  return rows
    .map(([input, expected]) => ({ input, expected, actual: ruleOf(input, host, tool) }))
    .filter((r) => r.actual !== r.expected)
}
