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
  /** Per-project test queue overrides; absent means inherit with no extra patterns. */
  testQueue?: ProjectTestQueue
  /** Per-project Claude launch overrides; absent means inherit the global settings. */
  claude?: ProjectClaude
  /** Per-project command guard overrides; absent means inherit the global settings. */
  guard?: ProjectGuard
}

export interface Session {
  id: string
  projectId: string
  title: string
  kind: SessionKind
  createdAt: number
  /** claude oturumunun --session-id değeri; "kaldığı yerden" bu sekmenin konuşmasını açar */
  claudeSessionId?: string
  /** Permission mode chosen when the tab was opened; absent means inherit project/global. */
  permissionMode?: PermissionMode
}

/**
 * Permission mode a Claude tab starts in. 'default' passes no flag (Claude's own settings
 * decide); 'manual' forces asking before each action (`--permission-mode default`).
 */
export type PermissionMode =
  'default' | 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'

export interface ClaudeSettings {
  /** Starting permission mode of Claude tabs. */
  permissionMode: PermissionMode
  /** Adds --allow-dangerously-skip-permissions: bypass is reachable with Shift+Tab. */
  allowBypass: boolean
}

export interface ProjectClaude {
  /** 'inherit' (stored as an absent field) uses the global setting. */
  permissionMode?: PermissionMode
}

/** Patch accepted by `projects.setClaude`. */
export interface ProjectClaudePatch {
  permissionMode?: PermissionMode | 'inherit'
}

export type UsageDisplay = 'used' | 'remaining'
export type TrayMetric = 'session' | 'weekly' | 'both'

export interface UsageSettings {
  /** Show meters and numbers as used or remaining percentage. */
  display: UsageDisplay
  /** Show ClaudeDeck in the macOS menu bar. */
  trayEnabled: boolean
  trayMetric: TrayMetric
  /** 'auto' = the account closest to a limit, 'selected' = the selected account, or an account id. */
  trayAccount: string
}

export interface Settings {
  /** null: sistem dilini kullan */
  language: Language | null
  usage: UsageSettings
  /** Open ClaudeDeck when the user logs in (packaged app only). */
  launchAtLogin: boolean
  testQueue: TestQueueSettings
  claude: ClaudeSettings
  guard: GuardSettings
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

/** A model-specific weekly limit from `/usage`, e.g. "Current week (Fable)". */
export interface ModelUsageWindow extends UsageWindow {
  model: string
}

export interface AccountUsage {
  accountId: string
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** Per-model weekly windows (only from the /usage poll; statusline does not report them). */
  models?: ModelUsageWindow[]
  /** When Claude Code last reported these numbers (epoch ms). */
  updatedAt: number
}

/** Subscription details read from the account's own Claude Code profile (no network). */
export interface AccountPlan {
  accountId: string
  /** Human label such as "Max 20x", "Max 5x", "Pro", or null when unknown. */
  label: string | null
  extraUsageEnabled: boolean | null
}

export interface TokenBreakdown {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface DailyUsage {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  /** API-equivalent cost estimate in USD. */
  costUSD: number
  tokens: TokenBreakdown
}

/** Token and API-equivalent cost totals from the account's local Claude Code transcripts. */
export interface AccountStats {
  accountId: string
  /** Last 30 days, oldest first, including empty days. */
  days: DailyUsage[]
  updatedAt: number
}

/* ---------------------------------------------------------------------------------------------
 * Test queue
 * ------------------------------------------------------------------------------------------- */

export type TestQueueMode = 'fixed' | 'auto'

/** Load based admission thresholds (automatic mode). */
export interface TestQueueAutoSettings {
  /** Upper limit of concurrent runs; null = clamp(floor(cpus / 4), 2, 6). */
  maxConcurrent: number | null
  /** Saturated after two samples above this CPU percentage. */
  cpuHighPercent: number
  /** Saturation clears below this CPU percentage (always below cpuHighPercent). */
  cpuResumePercent: number
  /** No new start while available memory is below this percentage. */
  minAvailableMemoryPercent: number
  /** Minimum seconds between two starts. */
  rampUpSeconds: number
}

/**
 * A user rule that marks a Bash command as a test run.
 * - `prefix`: token based, a trailing `*` matches any further tokens (e.g. `make e2e*`).
 * - `regex`: JavaScript regular expression, tested against the canonical (normalised) segment
 *   or the raw command.
 */
export interface TestPattern {
  id: string
  kind: 'prefix' | 'regex'
  pattern: string
  /** Only for `regex`; defaults to 'canonical'. */
  target?: 'canonical' | 'raw'
}

export interface TestQueueSettings {
  /** Opt-in: hooks are only written into accounts' settings.json while this is true. */
  enabled: boolean
  mode: TestQueueMode
  /** Concurrent runs in fixed mode. */
  maxConcurrent: number
  auto: TestQueueAutoSettings
  /** A test waiting longer than this is denied with a "queue full, run again" reason. */
  maxWaitMinutes: number
  /** A started run without evidence (process or PostToolUse) is released after this. */
  startGraceSeconds: number
  /** A background run without a matching process holds its slot at most this long. */
  backgroundMaxHoldMinutes: number
  /** Built-in pattern ids that are switched off. */
  disabledBuiltins: string[]
  customPatterns: TestPattern[]
}

/** Patch accepted by `settings.setTestQueue`; arrays replace the stored ones. */
export type TestQueueSettingsPatch = Partial<Omit<TestQueueSettings, 'auto'>> & {
  auto?: Partial<TestQueueAutoSettings>
}

export interface ProjectTestQueue {
  /** 'off' never queues commands from this project's tabs. */
  mode: 'inherit' | 'off'
  /** Built-in pattern ids switched off for this project only (on top of the global ones). */
  disabledBuiltins: string[]
  /** Extra rules for this project, checked after the global ones. */
  customPatterns: TestPattern[]
}

/**
 * queued -> starting -> running -> done; running -> background -> done;
 * queued -> cancelled | abandoned | expired. "Run now" is the `forced` flag, not a state.
 * - abandoned: the waiting hook went away (Esc, tab closed, hook killed).
 * - expired: max wait reached; the hook was denied with the retry reason.
 */
export type TestRunState =
  'queued' | 'starting' | 'running' | 'background' | 'done' | 'cancelled' | 'abandoned' | 'expired'

export interface TestRun {
  id: string
  /** ClaudeDeck tab (Session.id). */
  sessionId: string
  projectId: string
  accountId: string
  /** Set when a subagent issued the command. */
  agentId?: string
  agentType?: string
  /** Command as sent by Claude, truncated to 500 characters. */
  command: string
  /** Matching rule: a built-in pattern id or a custom pattern id. */
  ruleId: string
  state: TestRunState
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Started by "run now", over capacity. */
  forced: boolean
  /** Exactly one matching process tree was found, so "stop" can kill it. */
  canStop: boolean
}

/** Sampled system load used by automatic mode. */
export interface TestQueueLoad {
  /** Smoothed effective CPU busy percentage (0-100). */
  cpuPercent: number
  /** Smoothed available memory percentage (0-100). */
  availableMemoryPercent: number
  saturated: boolean
  lowMemory: boolean
  sampledAt: number
}

export interface TestQueueSnapshot {
  enabled: boolean
  mode: TestQueueMode
  /** Effective concurrency limit right now (fixed limit or auto upper limit). */
  limit: number
  /** Runs in starting, running or background state, then queued in order; finished ones drop out. */
  runs: TestRun[]
  /** Null in fixed mode or before the first sample. */
  load: TestQueueLoad | null
  updatedAt: number
}

/**
 * What a Claude tab sees through the ClaudeDeck MCP `get_test_queue` tool: its own account's
 * runs in full, other accounts' runs only as counts.
 */
export interface TestQueueAgentView {
  mode: TestQueueMode
  limit: number
  load: TestQueueLoad | null
  /** Runs of the caller's account (the caller's own tab and others). */
  runs: TestRun[]
  otherAccountsRunning: number
  otherAccountsWaiting: number
}

export type TestQueueHookProblem =
  /** Windows without Git Bash: there is no Bash tool either, so no hook is installed. */
  | 'noGitBash'
  /** settings.json is not valid JSON; it is never touched. */
  | 'invalidSettings'
  | 'writeFailed'

export interface TestQueueAccountHookStatus {
  accountId: string
  installed: boolean
  /** Last hook request received for this account (epoch ms). */
  lastCallAt: number | null
  problem: TestQueueHookProblem | null
}

export interface TestQueueHookStatus {
  accounts: TestQueueAccountHookStatus[]
  /**
   * The command guard is on: a project in `hooksDisabledProjectIds` (or `managedHooksOnly`)
   * means its tool calls are not guarded, which the UI should warn about.
   */
  guardEnabled?: boolean
  /** Managed settings set `allowManagedHooksOnly`: the queue cannot work anywhere. */
  managedHooksOnly: boolean
  /** Projects whose settings set `disableAllHooks`: the queue is off in their tabs. */
  hooksDisabledProjectIds: string[]
}

/** Ecosystem a built-in pattern belongs to; `exclusions` holds the built-in exclusions. */
export type TestQueueBuiltinGroup =
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'jvm'
  | 'dotnet'
  | 'ruby'
  | 'php'
  | 'beam'
  | 'mobile'
  | 'native'
  | 'haskell'
  | 'taskRunners'
  | 'exclusions'

/** A built-in pattern or exclusion for the Settings list (switched off via `disabledBuiltins`). */
export interface TestQueueBuiltin {
  id: string
  group: TestQueueBuiltinGroup
  /** English label from the classifier; the UI may map `id` to its own locale key instead. */
  label: string
  /** A command it matches (or, for an exclusion, one it lets through). */
  example: string
}

/** Result of classifying a command ("try a command" in Settings). */
export interface ClassifyResult {
  isTest: boolean
  /** Matching built-in or custom pattern id. */
  ruleId: string | null
  /** Where the matching rule comes from. */
  source: 'builtin' | 'custom' | 'project' | null
  /** Canonical form of the matching pipe segment (wrappers and flags stripped). */
  segment: string | null
  /** Exclusion that turned a match off (e.g. `--version`). */
  excludedBy: string | null
  /** Input was longer than the 16 KB limit and was cut. */
  truncated: boolean
}

/* ---------------------------------------------------------------------------------------------
 * Live agent viewer
 * ------------------------------------------------------------------------------------------- */

export type AgentStatus = 'running' | 'done' | 'idle'

export interface AgentSummary {
  agentId: string
  agentType: string
  description: string
  model: string | null
  background: boolean
  /** Nesting depth (spawnDepth); 1 for agents started by the main conversation. */
  depth: number
  status: AgentStatus
  startedAt: number
  lastActivityAt: number
  /** Tool of the last tool_use without a result. */
  currentTool?: string
  /** Single line preview (max 120 chars) of that call's main input: Bash command, file path. */
  currentToolInput?: string
  /** Test queue run this agent is waiting on or running. */
  queuedRunId?: string
}

export type AgentEventKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system'

/** One normalised transcript entry; text fields are plain text, truncated in main. */
export interface AgentEvent {
  /** Stable within the transcript (derived from the line's byte offset). */
  id: string
  kind: AgentEventKind
  at: number
  /** Tool name (tool_use). */
  tool?: string
  /** Pairs a tool_result with its tool_use. */
  toolUseId?: string
  /** Tool input preview, at most 1 KB. */
  inputPreview?: string
  isError?: boolean
  /** Message text (4 KB) or tool result (2 KB). */
  text?: string
}

export interface AgentOpenResult {
  /** Latest events, oldest first. */
  events: AgentEvent[]
  /** Pass to `agents.older` for the previous page; null at the start of the transcript. */
  cursor: number | null
}

/* ---------------------------------------------------------------------------------------------
 * Command guard
 * ------------------------------------------------------------------------------------------- */

export type GuardAction = 'allow' | 'ask' | 'deny'

/** Built-in rule categories; custom rules carry their own action. */
export type GuardCategoryId =
  'disk' | 'sensitive' | 'git' | 'fetchExec' | 'docker' | 'database' | 'publish' | 'system'

/** Tools the guard looks at (the hook matcher). */
export type GuardTool =
  'Bash' | 'PowerShell' | 'Monitor' | 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit'

/**
 * A user rule for commands (Bash, PowerShell, Monitor), matched like a test queue rule:
 * - `prefix`: token based, a trailing `*` matches any further tokens (`terraform apply*`).
 * - `regex`: JavaScript regular expression on the canonical command or the raw input.
 * An `allow` rule exempts the commands it matches from the built-in rules.
 */
export interface GuardCustomRule {
  id: string
  kind: 'prefix' | 'regex'
  pattern: string
  /** Only for `regex`; defaults to 'canonical'. */
  target?: 'canonical' | 'raw'
  action: GuardAction
}

export interface GuardSettings {
  /** On by default; the hook is installed in every account while the guard or queue is on. */
  enabled: boolean
  /** Action per built-in category. */
  categories: Record<GuardCategoryId, GuardAction>
  /** Per-rule actions that replace their category's action. */
  ruleOverrides: Record<string, GuardAction>
  customRules: GuardCustomRule[]
}

/** Patch accepted by `settings.setGuard`; objects and arrays replace the stored ones. */
export type GuardSettingsPatch = Partial<GuardSettings>

/** Project overrides, applied on top of the global settings. */
export interface ProjectGuard {
  categories: Partial<Record<GuardCategoryId, GuardAction>>
  ruleOverrides: Record<string, GuardAction>
  /** Extra rules for this project, checked after the global ones. */
  customRules: GuardCustomRule[]
}

/** A built-in rule for the settings list. */
export interface GuardRuleInfo {
  id: string
  category: GuardCategoryId
  /** Locale key of the rule's name (`guard.rules.<id>`). */
  label: string
  /** A command or path it matches. */
  example: string
  /** The category's action is capped at this for the rule (a rule override is not). */
  maxAction?: 'ask'
  /** The rule's action while its category is not set to allow (a rule override wins). */
  defaultAction?: 'deny'
}

/** Result of the guard for one tool call. */
export interface GuardDecision {
  action: GuardAction
  /** Category of the deciding rule; 'custom' for a user rule. */
  category?: GuardCategoryId | 'custom'
  /** Built-in rule id or custom rule id. */
  ruleId?: string
  /** Short, actionable text for Claude (permissionDecisionReason). */
  reasonForModel?: string
  /** Text shown to the user in the terminal (systemMessage). */
  messageForUser?: string
}

/** "Try a command" in Settings. */
export interface GuardEvaluateRequest {
  /** Defaults to Bash. Write, Edit, MultiEdit and NotebookEdit take a path in `input`. */
  tool?: GuardTool
  input: string
  /** Uses the project's folder and overrides. */
  projectId?: string
}

/** One guard decision with a matching rule (activity log, newest first). */
export interface GuardLogEntry {
  id: string
  at: number
  sessionId: string
  projectId: string
  accountId: string
  agentId?: string
  tool: GuardTool
  category: GuardCategoryId | 'custom'
  ruleId: string
  action: GuardAction
  /** Command or path, single line, at most 200 characters. */
  excerpt: string
}
