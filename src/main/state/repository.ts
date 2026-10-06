import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { DomainError } from '../../shared/errors'
import { LANGUAGES } from '../../shared/language'
import type {
  Account,
  AccountInput,
  AppState,
  Language,
  Project,
  ProjectInput,
  Session,
  SessionKind
} from '../../shared/types'
import type { JsonStore } from './jsonStore'

export const emptyState = (): AppState => ({
  accounts: [],
  projects: [],
  sessions: [],
  settings: { language: null }
})

function requirePath(value: unknown): string {
  const path = requireText(value)
  if (!isAbsolute(path)) throw new DomainError('INVALID')
  return path
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID')
  return value.trim()
}

export class Repository {
  private state: AppState

  constructor(
    private readonly store: JsonStore<AppState>,
    private readonly accountsRoot: string,
    private readonly newId: () => string = randomUUID
  ) {
    this.state = store.load()
  }

  get(): AppState {
    return this.state
  }

  account(id: string): Account {
    return this.find(this.state.accounts, id)
  }

  project(id: string): Project {
    return this.find(this.state.projects, id)
  }

  session(id: string): Session {
    return this.find(this.state.sessions, id)
  }

  createAccount(input: AccountInput): { state: AppState; account: Account } {
    const id = this.newId()
    const account: Account = {
      id,
      name: requireText(input.name),
      color: requireText(input.color),
      configDir: join(this.accountsRoot, id)
    }
    const state = this.commit({ ...this.state, accounts: [...this.state.accounts, account] })
    return { state, account }
  }

  updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'color' | 'email'>>): AppState {
    this.account(id)
    const clean: Partial<Account> = {}
    if (patch.name !== undefined) clean.name = requireText(patch.name)
    if (patch.color !== undefined) clean.color = requireText(patch.color)
    if ('email' in patch) clean.email = patch.email
    return this.commit({
      ...this.state,
      accounts: this.state.accounts.map((a) => (a.id === id ? { ...a, ...clean } : a))
    })
  }

  removeAccount(id: string): AppState {
    this.account(id)
    if (this.state.projects.some((p) => p.accountId === id)) throw new DomainError('ACCOUNT_IN_USE')
    return this.commit({ ...this.state, accounts: this.state.accounts.filter((a) => a.id !== id) })
  }

  createProject(input: ProjectInput): AppState {
    const project: Project = {
      id: this.newId(),
      name: requireText(input.name),
      path: requirePath(input.path),
      accountId: this.account(input.accountId).id
    }
    return this.commit({ ...this.state, projects: [...this.state.projects, project] })
  }

  updateProject(id: string, patch: Partial<ProjectInput>): AppState {
    this.project(id)
    const clean: Partial<Project> = {}
    if (patch.name !== undefined) clean.name = requireText(patch.name)
    if (patch.path !== undefined) clean.path = requirePath(patch.path)
    if (patch.accountId !== undefined) clean.accountId = this.account(patch.accountId).id
    return this.commit({
      ...this.state,
      projects: this.state.projects.map((p) => (p.id === id ? { ...p, ...clean } : p))
    })
  }

  removeProject(id: string): { state: AppState; removedSessionIds: string[] } {
    this.project(id)
    const removedSessionIds = this.state.sessions.filter((s) => s.projectId === id).map((s) => s.id)
    const state = this.commit({
      ...this.state,
      projects: this.state.projects.filter((p) => p.id !== id),
      sessions: this.state.sessions.filter((s) => s.projectId !== id)
    })
    return { state, removedSessionIds }
  }

  createSession(
    projectId: string,
    kind: SessionKind,
    title: string
  ): { state: AppState; session: Session } {
    this.project(projectId)
    if (kind !== 'claude' && kind !== 'shell') throw new DomainError('INVALID')
    const session: Session = {
      id: this.newId(),
      projectId,
      kind,
      title: requireText(title),
      createdAt: Date.now()
    }
    const state = this.commit({ ...this.state, sessions: [...this.state.sessions, session] })
    return { state, session }
  }

  renameSession(id: string, title: string): AppState {
    this.session(id)
    const clean = requireText(title)
    return this.commit({
      ...this.state,
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, title: clean } : s))
    })
  }

  setClaudeSessionId(id: string, claudeSessionId: string): AppState {
    this.session(id)
    return this.commit({
      ...this.state,
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, claudeSessionId } : s))
    })
  }

  removeSession(id: string): AppState {
    this.session(id)
    return this.commit({ ...this.state, sessions: this.state.sessions.filter((s) => s.id !== id) })
  }

  setLanguage(language: Language | null): AppState {
    if (language !== null && !LANGUAGES.includes(language)) throw new DomainError('INVALID')
    return this.commit({ ...this.state, settings: { ...this.state.settings, language } })
  }

  private find<T extends { id: string }>(list: T[], id: string): T {
    const item = list.find((x) => x.id === id)
    if (!item) throw new DomainError('NOT_FOUND')
    return item
  }

  private commit(next: AppState): AppState {
    this.store.save(next)
    this.state = next
    return next
  }
}
