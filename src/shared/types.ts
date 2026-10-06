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
