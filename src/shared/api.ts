import type {
  Account,
  AccountInput,
  AccountStatus,
  AppState,
  ClaudeSettings,
  GuardDecision,
  GuardEvaluateRequest,
  GuardLogEntry,
  GuardRuleInfo,
  GuardSettingsPatch,
  Language,
  PermissionMode,
  ProjectClaudePatch,
  ProjectGuard,
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
  AccountUsage,
  AccountPlan,
  AccountStats,
  SessionKind,
  UpdateInfo,
  UsageSettings,
  AgentEvent,
  AgentOpenResult,
  AgentSummary,
  ClassifyResult,
  TestQueueBuiltin,
  ProjectTestQueue,
  TestQueueHookStatus,
  TestQueueSettingsPatch,
  TestQueueSnapshot
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
    /** Project overrides for the test queue; arrays replace the stored ones. */
    setTestQueue(id: string, patch: Partial<ProjectTestQueue>): Promise<AppState>
    /** Project permission mode override; 'inherit' removes it. */
    setClaude(id: string, patch: ProjectClaudePatch): Promise<AppState>
    /**
     * Project command guard overrides; the fields given replace the stored ones (leave a
     * category out to inherit it). null, or a patch that leaves nothing, removes the override.
     */
    setGuard(id: string, patch: Partial<ProjectGuard> | null): Promise<AppState>
  }
  sessions: {
    create(
      projectId: string,
      kind: SessionKind,
      title: string,
      /** Claude tabs only: pins the tab's permission mode; omitted inherits. */
      permissionMode?: PermissionMode
    ): Promise<{ state: AppState; session: Session }>
    rename(id: string, title: string): Promise<AppState>
    remove(id: string): Promise<AppState>
    /** Main process asks the UI to select a session and start it (e.g. MCP open_session). */
    onOpenRequest(cb: (sessionId: string) => void): Unsubscribe
  }
  settings: {
    setLanguage(language: Language | null): Promise<AppState>
    setUsage(patch: Partial<UsageSettings>): Promise<AppState>
    setLaunchAtLogin(enabled: boolean): Promise<AppState>
    /** Validates and clamps; rejects with INVALID on bad values or a regex that does not compile. */
    setTestQueue(patch: TestQueueSettingsPatch): Promise<AppState>
    /** Starting permission mode and the bypass switch for Claude tabs started afterwards. */
    setClaude(patch: Partial<ClaudeSettings>): Promise<AppState>
    /**
     * Command guard settings. `categories` merges into the stored actions; `ruleOverrides` and
     * `customRules` replace them. Rejects with INVALID on unknown categories or actions, bad
     * rule ids, or a custom regex that does not compile or could backtrack catastrophically.
     * Turning the guard on or off installs or removes the accounts' hook (with the test queue).
     */
    setGuard(patch: GuardSettingsPatch): Promise<AppState>
  }
  pty: {
    startSession(
      sessionId: string,
      resume: boolean,
      cols: number,
      rows: number
    ): Promise<{ accountId: string; permissionMode: PermissionMode | null }>
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
  /** Plan usage reported by Claude Code through ClaudeDeck's statusline hook. */
  usage: {
    list(): Promise<AccountUsage[]>
    onUpdate(cb: (usage: AccountUsage) => void): Unsubscribe
    /** Re-query plan usage now (all accounts, or one); throttled in the main process. */
    pollNow(accountId?: string): Promise<null>
    plans(): Promise<AccountPlan[]>
    /** Local transcript statistics; rescans when older than a minute. */
    stats(): Promise<AccountStats[]>
    onStats(cb: (stats: AccountStats) => void): Unsubscribe
  }
  /** Test runs waiting for or holding a slot (main window only). */
  testQueue: {
    list(): Promise<TestQueueSnapshot>
    /** Pushed on changes, debounced in main (500 ms). */
    onUpdate(cb: (snapshot: TestQueueSnapshot) => void): Unsubscribe
    /** Denies a waiting run; the agent sees a fixed "cancelled by the user" reason. */
    cancel(runId: string): Promise<TestQueueSnapshot>
    /** Moves a waiting run to `position` among waiting runs (0 = next to start). */
    move(runId: string, position: number): Promise<TestQueueSnapshot>
    /** Starts a waiting run now, over capacity (`forced`). */
    runNow(runId: string): Promise<TestQueueSnapshot>
    /** Frees the slot of a stuck starting/running/background run without touching processes. */
    release(runId: string): Promise<TestQueueSnapshot>
    /** Kills the run's process tree; only when `TestRun.canStop` is true. */
    stop(runId: string): Promise<TestQueueSnapshot>
    /** Classifies a command with the current rules (plus the project's when given). */
    classify(command: string, projectId?: string): Promise<ClassifyResult>
    hookStatus(): Promise<TestQueueHookStatus>
    /** Built-in patterns, then the built-in exclusions (group `exclusions`), in display order. */
    builtins(): Promise<TestQueueBuiltin[]>
  }
  /** Command guard (main window only). */
  guard: {
    /** Built-in rules in display order; labels are locale keys (`guard.rules.<id>`). */
    rules(): Promise<GuardRuleInfo[]>
    /** Decision for a command (or a path for Write/Edit) with the current settings. */
    evaluate(request: GuardEvaluateRequest): Promise<GuardDecision>
    /** The last 200 decisions with a matching rule, newest first (memory only). */
    log(): Promise<GuardLogEntry[]>
    /** Each new log entry; show a notice when `action` is 'deny'. */
    onEvent(cb: (entry: GuardLogEntry) => void): Unsubscribe
  }
  /** Live subagent transcripts of Claude tabs; main derives every path (main window only). */
  agents: {
    /** Starts summary tracking for a running Claude tab; returns the current list. */
    watch(sessionId: string): Promise<AgentSummary[]>
    unwatch(sessionId: string): Promise<null>
    list(sessionId: string): Promise<AgentSummary[]>
    /** Full mode for one agent: latest events, then live ones through onEvents. */
    open(sessionId: string, agentId: string): Promise<AgentOpenResult>
    close(sessionId: string, agentId: string): Promise<null>
    /** Previous page before `cursor` (from AgentOpenResult). */
    older(sessionId: string, agentId: string, cursor: number): Promise<AgentOpenResult>
    /** Summaries of a watched tab, pushed at most every 250 ms. */
    onUpdate(cb: (sessionId: string, agents: AgentSummary[]) => void): Unsubscribe
    /** New events of the open agent, oldest first. */
    onEvents(cb: (sessionId: string, agentId: string, events: AgentEvent[]) => void): Unsubscribe
  }
  /** App level actions shared by the main window and the menu bar popover. */
  app: {
    /** Operating system the app runs on (`process.platform`), known before the first render. */
    readonly platform: NodeJS.Platform
    /** Profile optimization is available on this platform (same rule the main process applies). */
    readonly optimizeSupported: boolean
    /** The main window reports its selected account (menu bar 'selected' mode). */
    setSelectedAccount(accountId: string | null): void
    /** Account the menu bar currently shows, or null without accounts. */
    trayAccount(): Promise<string | null>
    /** Shows the main window, opening it again if it was closed. */
    openMain(): Promise<null>
    quit(): Promise<null>
    /** False in development builds, where login items are not registered. */
    packaged(): Promise<boolean>
    version(): Promise<string>
    /** Checks for an update now and answers with a native dialog (main window only). */
    checkUpdates(): Promise<null>
    /** The menu bar popover opened again (not on its first open, which loads the page). */
    onTrayShown(cb: () => void): () => void
    /** The menu bar popover asks for a window height that fits its content (popover only). */
    resizeTray(height: number): void
  }
}
