import type {
  Account,
  AccountInput,
  AccountStatus,
  AppState,
  Language,
  ProjectInput,
  Session,
  SessionKind,
  UpdateInfo
} from './types'

type Unsubscribe = () => void

export interface Api {
  state: { get(): Promise<AppState> }
  accounts: {
    create(input: AccountInput): Promise<{ state: AppState; account: Account }>
    update(id: string, patch: Partial<AccountInput>): Promise<AppState>
    remove(id: string, deleteFiles: boolean): Promise<AppState>
    status(id: string): Promise<{ status: AccountStatus; state: AppState }>
  }
  projects: {
    create(input: ProjectInput): Promise<AppState>
    update(id: string, patch: Partial<ProjectInput>): Promise<AppState>
    remove(id: string): Promise<AppState>
  }
  sessions: {
    create(
      projectId: string,
      kind: SessionKind,
      title: string
    ): Promise<{ state: AppState; session: Session }>
    rename(id: string, title: string): Promise<AppState>
    remove(id: string): Promise<AppState>
  }
  settings: { setLanguage(language: Language | null): Promise<AppState> }
  pty: {
    startSession(
      sessionId: string,
      resume: boolean,
      cols: number,
      rows: number
    ): Promise<{ accountId: string }>
    startLogin(accountId: string, cols: number, rows: number): Promise<null>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<null>
    onData(cb: (id: string, data: string) => void): Unsubscribe
    onExit(cb: (id: string, exitCode: number) => void): Unsubscribe
  }
  system: {
    pickFolder(): Promise<string | null>
    pathExists(path: string): Promise<boolean>
    claudeAvailable(): Promise<boolean>
    onOpenSettings(cb: () => void): Unsubscribe
  }
  update: {
    /** Paketlenmemiş (geliştirme) sürümde ya da hata durumunda null döner. */
    check(): Promise<UpdateInfo | null>
    open(): Promise<null>
    onAvailable(cb: (info: UpdateInfo) => void): Unsubscribe
  }
}
