# Test queue and live agent viewer

Date: 2026-10-07
Status: Approved

## Summary

**A. Test queue.** An app-managed `PreToolUse(Bash)` hook in each account's `settings.json`
long-polls a new route on the existing loopback server (MCP server). `TestQueueService` in the
main process classifies the command: non-test returns immediately; a test waits until its turn
and capacity allow. The hook never rewrites the command (`updatedInput`) and never returns a
permission decision, so users' permission rules and own hooks are untouched. Completion is
tracked with `PostToolUse`, and with process discovery for runs that move to the background.

**B. Agent viewer.** No hooks needed. Using the tab's `claudeSessionId`, watch
`<configDir>/projects/<key>/<sessionId>/subagents/`, read JSONL incrementally by byte offset
(line-safe). Light summaries for all running tabs; full transcript only for the open viewer.

## Verified facts (Claude Code 2.1.282)

- PreToolUse can rewrite with `hookSpecificOutput.updatedInput` (replaces the whole input);
  permission rules apply to the rewritten input; `"allow"` skips the prompt (deny/ask rules
  still apply). Subagent Bash calls hit the same hook with `agent_id`, `agent_type`.
- Command hook timeout default 600 s, per-hook `timeout` in seconds. A slow hook blocks the tool
  and its time does not count against the Bash timeout. A timed-out or crashed hook lets the tool
  run (fail-open). Esc during a waiting hook: unverified.
- Bash tool: 120 s default, 600 s max; a foreground command hitting the timeout moves to the
  background; time inside a wrapper counts against the timeout.
- Account `settings.json` hooks apply to all projects and merge with project hooks; project
  `disableAllHooks` or managed `allowManagedHooksOnly` disable ours; interactive sessions wait for
  workspace trust; settings reload live.
- Hook processes inherit the claude env (`CLAUDEDECK_MCP_TOKEN` reaches hooks, also in subagents).
- Subagent transcripts: `<configDir>/projects/<key>/<sessionId>/subagents/agent-<id>.jsonl`
  (appended live) and `agent-<id>.meta.json` (`agentType, description, toolUseId, spawnDepth,
  requestShape, model`). SubagentStart/Stop hooks exist.
- `ELECTRON_RUN_AS_NODE` is not an option: the `runAsNode` fuse is off in packaged builds.

## A. Test queue

### Endpoint
Routes on the existing loopback server: `POST /hooks/test-queue/pre` and `/post`.
`startMcpServer` takes optional `routes`; loopback check, Origin rejection and token lookup are
shared; hook routes get their own rate limiter (600/min per token). Long-poll responses may stay
open for the configured maximum wait (`server.timeout` 0, covered by a test).

### Hook helper
Generated POSIX `sh` script + `curl` (`<configDir>/claudedeck/test-queue.sh`), run with
`/bin/sh` on macOS and Git Bash on Windows (`"shell": "bash"`). Windows without Git Bash: no
Bash tool either, so the hook is not installed and Settings says why. If Windows overhead exceeds
250 ms per Bash call, switch to a small compiled helper (phase 5) with the same contract.

Script behaviour:
- Exit 0 silently unless `CLAUDEDECK_MCP_TOKEN` matches `^[0-9a-f]{64}$` and
  `CLAUDEDECK_HOOK_URL` matches `^http://127\.0\.0\.1:[0-9]+/`. Other `claude` processes using the
  same config dir (and shell tabs) are unaffected.
- Token never on argv: body `{"t":token,"e":"pre|post","p":<stdin JSON>}` piped to
  `exec curl -s --data-binary @- "$URL"`. `exec` makes curl the hook process, so a killed hook
  closes the socket and the server sees it.
- No `--fail`: the server returns an empty body whenever there is no decision (401 included).
- curl `--max-time` = `maxWaitMinutes*60 + 30`; hook `timeout` = `maxWaitMinutes*60 + 60`.
- `CLAUDEDECK_HOOK_URL` is set per tab next to the token (no port baked into the script).

settings.json: our groups are added to `hooks.PreToolUse` (matcher `Bash`) and
`hooks.PostToolUse` / `PostToolUseFailure` (`post`, timeout 10, async if supported). Recognised
by `/claudedeck[\\/]test-queue\.sh/`; idempotent; removed when the feature is off or the account
is removed; re-synced after optimize runs (settingsGuard restores `hooks`). Script names join
`APP_MANAGED_FILES`. `readSettings`/`writeIfChanged` move from `statusline.ts` to
`src/main/profile/settingsFile.ts`, shared by statusline and hook installers.

### Tab identity
Token → `SessionScope {sessionId, projectId, accountId}`; only `kind === 'session'` and
`ptys.has(sessionId)`. Subagent info from payload `agent_id`, `agent_type`.

### Waiting, cancel, abandon, completion
States: `queued → starting → running → done`, `running → background → done`,
`queued → cancelled | abandoned | forced`.
- Each waiter is an open HTTP response; `res.on('close')` → `abandoned`. Pty exit, token revoke
  and renderer reload drop the session's entries.
- UI cancel answers the waiter with `permissionDecision: "deny"` and a fixed reason. Also
  "move up", "run now" (forced, over capacity) and "release" for a stuck running entry.
- Foreground completion: `PostToolUse`/`PostToolUseFailure` with the same `tool_use_id`.
- Background (`run_in_background` or auto-backgrounded): `background` state; find the shell
  process under the pty whose command line carries the runner token; hold the slot while that pid
  lives (2 s checks); without a pid, hold until `backgroundMaxHoldMinutes` (30) or pty exit.
- `starting` without evidence (permission prompt, denial, Esc): probes at 10/30/60 s; release
  after `startGraceSeconds` (120) without a matching process or PostToolUse.
- Not wrapping the command (no `updatedInput` lease): keeps permission rules, prompt text and
  transcripts unchanged and avoids conflicts with users' rewriting hooks.

### Permission decision
None. Pass-through = empty stdout, exit 0. Only a user cancel returns `deny`. Returning `allow`
would silently approve `npm test`-style commands that run arbitrary repo scripts. Waiting happens
before the permission prompt.

### Fail-open
Hooks persist in settings.json, so failing closed could lock all Bash use when the app has a
problem. Pass through when: no token/URL, server unreachable, body too large, rate limited,
capacity (20 per session, 200 global) full, hook timeout or crash. Max wait is the exception:
it denies (see Decisions).
UX: static detection of `disableAllHooks` / `allowManagedHooksOnly` (project and managed
settings) → "queue disabled in this tab" badge; per-account "last hook call" time in Settings;
Windows without Git Bash note. v1 covers the Bash tool only (Windows PowerShell tool in v2).

### Users' own PreToolUse hooks
Hooks run in parallel; if theirs denies, ours may still wait (slot returns after `startGrace`).
If theirs rewrites, we classify the original; the runner-token fingerprint usually still
matches, otherwise `backgroundMaxHold` applies. We never produce `updatedInput`.

### Automatic (load-based) mode
`src/main/platform/systemLoad.ts`, pure with injected OS deps.
- CPU: `os.cpus()` time deltas → busy; on POSIX also `min(1, loadavg[0]/cpuCount)`; effective =
  max. Windows uses busy only.
- Memory: Windows `freemem/totalmem`; macOS `sysctl -n kern.memorystatus_level` (fallback
  `vm_stat`), chosen in the spike.
- Sample every 2 s only while entries exist; EMA α=0.35.
- Hysteresis: saturated after two samples above `cpuHighPercent` (85), cleared below
  `cpuResumePercent` (65); memory floor `minAvailableMemoryPercent` (15) with a 5 point band.
- Admission per tick (at most one start): always start if nothing runs; never above `autoMax`
  (default `clamp(floor(cpus/4), 2, 6)`, user 1..32); not while saturated or low on memory; not
  within `rampUpSeconds` (20) of the last start. No preemption. FIFO with manual reordering.
- Fixed mode: `active < maxConcurrent` (ramp 0 by default).

### Test command detection
`src/main/testQueue/classifier/`, pure; Settings "try a command" uses it over IPC.
1. `shellLexer.ts`: POSIX tokenizer (quotes, escapes, `$(...)`/backticks opaque, heredoc bodies
   skipped, `&& || ; | & \n ( )`), each pipe segment evaluated.
2. `normalize.ts`: skip `VAR=val`, `cd/pushd/export/set`; strip wrappers (`env`, `time`, `nice`,
   `timeout`, `command`, `exec`, `xvfb-run`, `cross-env`, `dotenv --`, `npx/pnpx/bunx/yarn dlx/
   pnpm dlx/pnpm exec/npm exec`, `uv/poetry/pipenv/hatch/pdm/rye run`, `bundle exec`,
   `python -m`, `py -m`, `./gradlew`→`gradle`, `./mvnw`→`mvn`); package manager flags
   (`pnpm -C/--dir/--filter/-F/-r/-w`, `npm --prefix/-w/-ws`, `yarn --cwd/workspace`,
   `bun --cwd`); monorepo runners (`turbo run`, `nx`, `nx run-many/affected -t`, `lerna run`);
   recurse into `bash|sh|zsh -c '...'` (depth ≤ 2).
3. `builtinPatterns.ts` (ids, grouped by ecosystem): `(npm|pnpm|yarn|bun) (run )?test*`, `npm t`,
   vitest, jest, mocha, ava, tap, `playwright test`, `cypress run`, pytest, `python -m
   pytest|unittest`, tox, nox, `go test`, `cargo test|nextest run`, `mvn test|verify`,
   `gradle test|check`, `dotnet test`, rspec, `rails test`, `rake test|spec`, phpunit, pest,
   `php artisan test`, `composer test`, `mix test`, `swift test`, `flutter test`, `deno test`,
   ctest, `make|just|task test|check`.
4. Exclusions (built in, can be disabled): `--version`, lone `-v`, `--help`, `--list`,
   `--listTests`, `--collect-only`, `-list`.
5. User rules: `prefix` (token-based, trailing `*`) or `regex` (target canonical or raw); quoted
   arguments never count as commands (`git commit -m "pnpm test"` does not match).
6. Limits: regex ≤ 300 chars, ≤ 100 rules, compiled on save; input truncated to 16 KB.

### Settings
```
Settings.testQueue: {
  enabled: false, mode: 'fixed' | 'auto' = 'auto', maxConcurrent: 2,
  auto: { maxConcurrent: null, cpuHighPercent: 85, cpuResumePercent: 65,
          minAvailableMemoryPercent: 15, rampUpSeconds: 20 },
  maxWaitMinutes: 60, startGraceSeconds: 120, backgroundMaxHoldMinutes: 30,
  disabledBuiltins: string[], customPatterns: TestPattern[]
}
Project.testQueue?: { mode: 'inherit' | 'off', disabledBuiltins, customPatterns }
```
Off by default (opt-in): a public app must not write hooks into users' settings.json without
consent. Deep-merged defaults in `repository.withDefaultSettings`; setters validate and clamp.

### IPC
`testQueue:list | update (push) | cancel | move | runNow | release | classify | hookStatus`,
`settings:setTestQueue`, `project:setTestQueue`. Main window only, not the tray.
`TestRun { id, sessionId, projectId, accountId, agentId?, agentType?, command (≤500), ruleId,
state, enqueuedAt, startedAt?, forced }`, snapshot with `load` (500 ms debounce).

### UI
- Sidebar indicator above the usage panel: "2/3 running · 4 waiting", mini CPU/memory in auto
  mode; hidden when off. Click opens the queue panel (running/waiting, project, tab, agent type,
  command, times, actions).
- Tab badge while waiting (hourglass + position); warning icon when hooks are disabled there.
- Settings section: toggle, mode, limit, max wait, advanced thresholds, built-in patterns grouped
  by ecosystem with switches, custom rules, "try a command", hook status per account.
- Project dialog: inherit/off and extra patterns.
- In-app notices only (install failure, no Git Bash, queue disabled in a tab).

## B. Live agent viewer

### Data flow
- `subagentsDir(configDir, project.path, claudeSessionId)` with `encodeProjectKey` (same key as
  `transcriptPath`), realpath variant as fallback. Never created by us.
- `agentWatcher.ts` (main, ref-counted): wait for the session dir, then `fs.watch` (150 ms
  debounce) plus a 1 s fallback scan while agents run. Closed before account removal and project
  moves on Windows (`forgetUsage` pattern).
- `jsonlTail.ts`: per file `{offset, carry}`; read new bytes, split on `0x0A`, decode complete
  lines only; restart on truncation; skip lines over 1 MB; bad JSON lines dropped.
- `transcriptParse.ts`: normalise to `{kind: text|tool_use|tool_result|system, at, tool?,
  inputPreview?, isError?, text?}` with truncation (4 KB text, 1 KB input, 2 KB result);
  `currentTool` = last unmatched tool_use.
- Meta from `agent-<id>.meta.json`; ids validated `^[A-Za-z0-9_-]{1,64}$`.
- Status: foreground done when the parent transcript has the `tool_result` for `toolUseId`;
  background done on the completion notice in the parent (format verified in the spike);
  fallback `idle` after 60 s without activity or pending tool_use. Optional exact status via
  SubagentStart/Stop hooks in phase 5.
- Summary mode for every running Claude tab (meta + last 64 KB); full mode only for the agent
  open in the viewer (ring buffer ≤ 1000 events, older pages by byte cursor).
- Limits: ≤ 100 summaries per session; everything released on unwatch, tab close, reload.

### IPC
`agents:watch | unwatch | list | open | close | older`, pushes `agents:update` (250 ms) and
`agents:events`. The renderer never sends paths.
`AgentSummary { agentId, agentType, description, model, background, depth,
status: running|done|idle, startedAt, lastActivityAt, currentTool?, queuedRunId? }`.

### UI
`AgentsToggle` next to `NotesToggle` (badge = running agents, Claude tabs only); the right panel
shows notes or agents (`useSidePanel`). List: status dot, type badge, description, model chip,
foreground/background icon, elapsed time, current tool line, indentation by depth. Detail:
live transcript, collapsible tool calls, plain text (no HTML), links via `confirmOpenExternal`.

## Security
- Hook routes: loopback, Origin rejected, token in body (SHA-256 lookup), session scope with a
  live pty only, body limits (pre 1 MB, post 4 MB), `tool_name === 'Bash'`, rate and capacity
  limits; overflow passes through.
- The server never executes or shells out the command. Script from a fixed template with quoted
  paths; token and URL validated in the script; responses built with `JSON.stringify` from
  constants. Process discovery via `execFile` with fixed args and numeric pids.
- settings.json writes atomic, 0600, only our groups, never touching invalid JSON.
- Never `allow`, never `updatedInput`.
- Viewer: paths derived in main, ids validated, transcript content in memory only, not exposed
  to the tray.

## Testing
Unit: lexer/classifier tables (~150 cases), scheduler with fake clock and load, systemLoad,
hook script snapshot (macOS pinned), hook install (user hooks kept, idempotent, removal, invalid
JSON), repository defaults, process list parsers, jsonlTail, transcript reducer with anonymised
fixtures. Server: real http on port 0 (unauthorised, Origin, body limit, close during long-poll,
rate limit). Script integration test against a fake server on macOS and Windows CI. Manual E2E:
three tabs with subagents running a `sleep` test script, Esc while waiting, permission prompt
during reservation, background run, app quit, `disableAllHooks` project, Windows.

## Phases
0. Spike (no repo code): `tool_use_id` in pre/post payloads; PostToolUse timing and
   `tool_response` for background runs; PostToolUseFailure and async hooks; Esc and a waiting
   hook; 1 h long-poll; Windows Git Bash + curl overhead; shell command lines visible to ps/CIM;
   session id and subagents dir after `--resume`; agent completion markers; managed settings
   paths; macOS memory metric.
1. Contracts: shared types/ipc/api/preload stubs, repository settings, `settingsFile.ts`.
2. Backend in parallel: classifier; queue service + hooks + server routes + platform load and
   process list + wiring; agent watcher.
3. Frontend in parallel: queue UI + settings + locales owner; agents panel + side panel store.
4. Quality gate: code review, security, Windows CI script test, docs.
5. Conditional: compiled helper, SubagentStart/Stop hooks, PowerShell tool, global agent view.

## Decisions (from the user)
1. Max wait reached: deny with a fixed reason telling the agent the queue is full and that
   running the same command again puts it back in the queue. A retry from the same tab within
   10 minutes keeps its original enqueue time, so it is not sent to the back.
2. Running tests can be stopped from the queue panel. Stop kills the process tree found by
   process discovery (pty descendants whose command line matches the run's fingerprint); the
   button is only enabled when exactly one matching process tree is found, otherwise the panel
   offers "release" only. Uses `platform.killTree`.
3. Agent viewer: per-tab panel only in v1.
4. Agents can see and manage the queue through the ClaudeDeck MCP server (session tokens only,
   not optimize runs):
   - `get_test_queue`: mode, limit, load, and runs. Runs of the caller's own account show
     project, tab, agent type, command and times; runs of other accounts are counted only
     (no commands or project names), matching the existing MCP account scoping.
   - `cancel_test_run(runId)`: cancels a waiting run (the waiting hook receives the deny) or
     stops a running one (same rules as the panel's Stop). Allowed only for runs started by the
     caller's own tab, including its subagents; anything else returns "Not allowed".
   - `move_test_run` / `run_now` are not exposed to agents (queue priority stays with the user).
   - Counted by the existing per-tab MCP rate limit; no confirmation dialog (only affects the
     caller's own runs).

## Spike results (phase 0) and design changes

Verified on 2.1.282 (macOS; Windows from docs/binary strings). Raw notes: tqspike scripts.

- `tool_use_id` is in PreToolUse and PostToolUse/PostToolUseFailure, same value. Exactly one of
  PostToolUse (success) or PostToolUseFailure (`error`, `is_interrupt`) fires.
- Background: PostToolUse fires at hand-off, with `tool_response.backgroundTaskId` (and
  `timedOutAfterMs` when auto-backgrounded). No hook fires when a background command ends.
  The parent transcript gets a `{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id>…<status>completed</status><summary>… (exit code N)</summary>…"}`
  line right away. **Background completion = this line, matched by tool-use-id.** Process
  discovery and `backgroundMaxHold` are fallbacks only.
- Async PostToolUse hooks work but are killed when claude exits; keep start-grace probes.
- A long-poll hook waits the full hook timeout. curl is a direct child of claude in its own
  process group. SIGTERM/SIGHUP to claude closes curl (server sees close); SIGKILL leaves curl
  orphaned, so **on pty exit the server must end that session's waiters itself**.
- Esc while a hook waits: verified; curl is killed and the server sees the close within ~0.5 s.
- Foreground Bash process shape: `$SHELL -c source …/shell-snapshots/snapshot-….sh … && eval '<cmd>' …`
  (child of claude, process group leader), then the command's own processes. Fingerprint: the
  snapshot wrapper (`shell-snapshots/snapshot-` and `eval '`) with `'"'"'` unquoted, or its
  child's raw command line. Stop kills that process group. MCP servers are also claude children.
- `--resume` keeps the session id and the same `subagents/` folder (`-p` verified).
- Subagent completion: foreground = `tool_result` for the Agent `toolUseId` (with
  `toolUseResult.status:"completed"`, `agentId`, `resolvedModel`, totals); background =
  `<task-notification>` enqueue line whose task-id is the agentId (may repeat; idempotent).
  `meta.json` has no `model`: use `message.model` in the subagent transcript or `resolvedModel`;
  meta also has `requestNonInteractive`.
- Managed settings: macOS `/Library/Application Support/ClaudeCode/managed-settings.json`,
  Windows `C:\Program Files\ClaudeCode\managed-settings.json` (+ `managed-settings.d/`), MDM plist
  `com.anthropic.claudecode`, registry `HKLM|HKCU\SOFTWARE\Policies\ClaudeCode`. Top-level
  `disableAllHooks` / `allowManagedHooksOnly`; policy `disableAllHooks` implies managed-only.
  Detection also checks user settings.
- macOS memory: `kern.memorystatus_level` (≈ system pressure view); fallback `vm_stat`
  (free + inactive + purgeable + speculative); never `os.freemem` on macOS.
- Windows: hooks default to `"shell":"bash"`; without Git Bash Claude uses the PowerShell tool,
  so the notice reads "the queue covers the Bash tool; this machine uses PowerShell".

Shared module: `src/main/transcripts/` (owned by the agent viewer stream) provides incremental
JSONL tailing and a session transcript watcher that emits `taskNotification {taskId, toolUseId,
status, exitCode?}` and `toolResult {toolUseId, isError}` events; the queue consumes it for
background completion.
