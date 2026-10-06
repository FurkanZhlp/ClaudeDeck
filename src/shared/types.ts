export type SessionKind = 'claude' | 'shell'
export type Language = 'tr' | 'en'

export interface Account {
  id: string
  name: string
  color: string
  configDir: string
  email?: string
}

export interface Project {
  id: string
  name: string
  path: string
  accountId: string
}

export interface Session {
  id: string
  projectId: string
  title: string
  kind: SessionKind
  createdAt: number
  /** claude oturumunun --session-id değeri; "kaldığı yerden" bu sekmenin konuşmasını açar */
  claudeSessionId?: string
}

export interface Settings {
  /** null: sistem dilini kullan */
  language: Language | null
}

export interface AppState {
  accounts: Account[]
  projects: Project[]
  sessions: Session[]
  settings: Settings
}

export interface AccountStatus {
  loggedIn: boolean
  email?: string
}

export type AccountInput = Pick<Account, 'name' | 'color'>
export type ProjectInput = Pick<Project, 'name' | 'path' | 'accountId'>

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string | null
  available: boolean
  url: string
}

export type ProfileCategory =
  'instructions' | 'agents' | 'skills' | 'commands' | 'outputStyles' | 'settings' | 'plugins'

/** Where a profile import copies from: the user's global ~/.claude or another account. */
export type ProfileSource = { kind: 'global' } | { kind: 'account'; accountId: string }

export interface ProfileCategorySummary {
  category: ProfileCategory
  /** Whether the source has anything for this category. */
  available: boolean
  /** Number of top-level entries (files or folders) in the source for this category. */
  items: number
}

export interface ProfileDiffEntry {
  category: ProfileCategory
  added: number
  changed: number
  removed: number
}

export interface ProfileImportResult {
  imported: ProfileCategory[]
  /** Folder holding the previous versions of overwritten items, or null if nothing was replaced. */
  backupDir: string | null
}

export interface GuidelinesUpdate {
  accountId: string
  from: number | null
  to: number
}

export interface NoteFile {
  /** File name, e.g. "MEMORY.md". */
  name: string
  updatedAt: number
  size: number
}

export interface McpInfo {
  running: boolean
  url: string | null
}

export type OptimizeStatus =
  'idle' | 'starting' | 'running' | 'waiting' | 'finished' | 'failed' | 'cancelled'

/** One proposal Claude asks the user about during profile optimization. */
export interface OptimizeQuestion {
  id: string
  title: string
  /** Why Claude proposes it (Markdown). */
  rationale: string
  /** Profile-relative paths the change would touch. */
  files: string[]
  /** Optional Markdown preview of the change (e.g. a diff block). */
  preview?: string
  askedAt: number
}

export type OptimizeDecision = 'apply' | 'skip' | 'modify'

export interface OptimizeAnswer {
  questionId: string
  decision: OptimizeDecision
  /** Instructions from the user when decision is 'modify'. */
  note?: string
  answeredAt: number
}

export type OptimizeEvent =
  | { type: 'status'; message: string; at: number }
  | { type: 'activity'; tool: string; target?: string; at: number }
  | { type: 'findings'; summary: string; strengths: string[]; issues: string[]; at: number }
  | { type: 'question'; question: OptimizeQuestion; at: number }
  | { type: 'answer'; answer: OptimizeAnswer; at: number }
  | { type: 'finish'; summary: string; changes: string[]; at: number }
  | { type: 'error'; message: string; at: number }

export interface OptimizeState {
  accountId: string
  status: OptimizeStatus
  startedAt: number | null
  finishedAt: number | null
  /** Snapshot of the profile taken by ClaudeDeck before Claude started. */
  backupDir: string | null
  events: OptimizeEvent[]
  /** Proposal waiting for the user's answer, if any. */
  pending: OptimizeQuestion | null
  reverted: boolean
}

/** One plan rate-limit window as reported by Claude Code (statusline `rate_limits`). */
export interface UsageWindow {
  /** 0-100. */
  usedPercentage: number
  /** Epoch milliseconds. */
  resetsAt: number
}

export interface AccountUsage {
  accountId: string
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** When Claude Code last reported these numbers (epoch ms). */
  updatedAt: number
}
