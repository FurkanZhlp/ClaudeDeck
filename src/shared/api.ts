import type {
  Account,
  AccountInput,
  AccountStatus,
  AppState,
  Language,
  ProjectInput,
  Session,
  GuidelinesUpdate,
  McpInfo,
  NoteFile,
  ProfileCategory,
  ProfileCategorySummary,
  ProfileDiffEntry,
  ProfileImportResult,
  ProfileSource,
  OptimizeDecision,
  OptimizeState,
  SessionKind,
  UpdateInfo
} from './types'

type Unsubscribe = () => void

export interface Api {
  state: {
    get(): Promise<AppState>
    /** Main process changed the state on its own (e.g. through the MCP server). */
    onChanged(cb: (state: AppState) => void): Unsubscribe
  }
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
    /** Main process asks the UI to select a session and start it (e.g. MCP open_session). */
    onOpenRequest(cb: (sessionId: string) => void): Unsubscribe
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
  profile: {
    /** What the source offers per category; `global` reads ~/.claude without modifying it. */
    summarize(source: ProfileSource): Promise<ProfileCategorySummary[]>
    /** What importing would change in the account's profile, per category. */
    diff(accountId: string, source: ProfileSource): Promise<ProfileDiffEntry[]>
    import(
      accountId: string,
      source: ProfileSource,
      categories: ProfileCategory[]
    ): Promise<ProfileImportResult>
    /** Starts the optimize Claude session in PTY `optimizePtyId(accountId)`. */
    startOptimize(accountId: string, cols: number, rows: number): Promise<null>
    openFolder(accountId: string): Promise<null>
    onGuidelinesUpdated(cb: (update: GuidelinesUpdate) => void): Unsubscribe
    /** Upgrades found before the UI was ready; returned once, then cleared. */
    takeGuidelineUpdates(): Promise<GuidelinesUpdate[]>
  }
  notes: {
    list(projectId: string): Promise<NoteFile[]>
    read(projectId: string, name: string): Promise<string>
    /** Starts watching the project's memory folder; changes arrive via onChanged. */
    watch(projectId: string): Promise<null>
    unwatch(projectId: string): Promise<null>
    onChanged(cb: (projectId: string) => void): Unsubscribe
    open(projectId: string, name: string): Promise<null>
    reveal(projectId: string): Promise<null>
  }
  mcp: { info(): Promise<McpInfo> }
  /** Headless profile optimization driven by Claude through ClaudeDeck MCP tools. */
  optimize: {
    start(accountId: string): Promise<OptimizeState>
    get(accountId: string): Promise<OptimizeState>
    list(): Promise<OptimizeState[]>
    answer(
      accountId: string,
      questionId: string,
      decision: OptimizeDecision,
      note?: string
    ): Promise<OptimizeState>
    cancel(accountId: string): Promise<OptimizeState>
    /** Restores the snapshot taken before the run (current files are backed up first). */
    revert(accountId: string): Promise<OptimizeState>
    onUpdate(cb: (state: OptimizeState) => void): Unsubscribe
  }
}
