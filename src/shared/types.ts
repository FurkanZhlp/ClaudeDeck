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
