# Command guard and settings redesign

Date: 2026-10-09
Status: Approved (user decisions included)

## Goals

1. A command guard that catches harmful or likely-mistaken tool calls by Claude (and its
   subagents) through ClaudeDeck's PreToolUse hook, in every permission mode including bypass.
2. Categories with a per-category action (allow / ask / deny), per-rule overrides, custom rules,
   per-project overrides.
3. Settings become a Discord-style full-screen view with a section list on the left.

## Safety rule for development (absolute)

Never execute, and never let Claude or a test execute, a destructive or risky command (rm, dd,
mkfs, diskutil, format, Remove-Item, del/rd, chmod/chown on system paths, git push/reset/clean,
kill, shutdown, curl|sh, DROP, docker prune, publish, …), not even in temp dirs or with a dry-run
flag. Rule tests pass command strings to the pure evaluator only. Hook integration tests use
harmless sentinel commands (`echo GUARD-SENTINEL-…`) with a test rule matching the sentinel.
Cleaning up test files uses truncation or the test framework's temp dir removal, never shell rm.

## Verified Claude Code behaviour (2.1.282, sentinel-only tests)

- PreToolUse JSON `permissionDecision: "deny"` blocks in every mode, including
  bypassPermissions and --dangerously-skip-permissions. `"ask"` is never auto-approved: it
  prompts interactively (bypass included); in -p/dontAsk it becomes a denial. Auto mode: per docs,
  deny is honoured and ask forces a prompt.
- `permissions.deny` rules apply in every mode including bypass.
- Deny reason reaches the model as the tool error; a top-level `systemMessage` is shown to the
  user. Prefer JSON deny over exit 2 (exit 2 leaks the hook path).
- Tools: Bash, PowerShell (Windows without Git Bash; same input shape), Monitor (`command`),
  Write/Edit (`file_path`, absolute), MultiEdit (legacy), NotebookEdit (`notebook_path`). One
  matcher `Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit`. Subagent calls included.
- Out of reach: user-typed `!cmd`, the user's own terminal, `@file` references.
- Built in already: critical-path `rm`/`rmdir` (root, top-level dirs, home, cwd and parents,
  drive roots, risky globs/variables; inside `$(...)`, `bash -c`) and PowerShell `Remove-Item`
  on system paths. Not covered by Claude: dd, mkfs, diskutil, force push, reset --hard, clean,
  curl|sh, chmod -R, kill, shutdown, DROP, docker prune, publish. Bypass allows writes to
  protected paths (.git, shell rc files, .claude, …): the guard covers that gap.
- A timed-out or crashed command hook fails open; exit 1 does not block.

## Architecture

- One ClaudeDeck hook (the existing test queue hook, generalised and renamed
  `claudedeck/hook.sh`) with matcher `Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit`.
  Installed in each account's settings.json when the guard or the queue is enabled. The old
  `test-queue.sh` entry is migrated (removed, replaced).
- `POST /hooks/pre`: the server first runs the guard (pure, fast). A deny or ask is returned
  immediately (`permissionDecision`, `permissionDecisionReason` for the model, `systemMessage`
  for the user). If allowed and the tool is Bash/PowerShell and the queue is on, the existing
  queue flow continues (short-poll). Post hooks stay queue-only.
- Guard failure handling: when the tab has a valid token but the server cannot be reached or
  errors during the guard step, the script returns `deny` with "ClaudeDeck command guard is
  unavailable" (fail closed for our own tabs only; tabs exist only while ClaudeDeck runs). The
  guard step has a 5 s budget. Without a token (other claude processes) the script exits 0.
- Evaluator: `src/main/guard/` reusing `testQueue/classifier/shellLexer` + `normalize` (move them
  to a shared `src/main/shell/` module). PowerShell commands get a small tokenizer for the common
  forms (Remove-Item/rm/del/rd/Format-Volume/Clear-Disk/Stop-Computer/iwr|iex). Paths are
  resolved against the hook `cwd`, `~`/`$HOME`/`%USERPROFILE%` expanded, symlinks not followed.
- Decision: highest severity wins across segments (deny > ask > allow). Unknown or unparsable
  input with an obviously dangerous token falls back to ask.

## Categories (default action)

| Id | Category | Examples | Default |
|---|---|---|---|
| disk | Disk and system | mkfs, newfs, diskutil erase/partition/zeroDisk, dd of=/dev/…, format X:, Format-Volume, Clear-Disk, diskpart, fork bomb, rm/find -delete/xargs rm on system paths beyond Claude's built-ins, chmod/chown -R on system or home roots | deny |
| sensitive | Sensitive files | writes or deletes in ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, /etc, /System, /Library, C:\Windows, shell rc files, ~/.gitconfig, ~/.claude, other ClaudeDeck account dirs, .git internals (outside git commands); reading private keys via cat/cp/scp | deny |
| git | Git | push --force/-f/--force-with-lease to any branch (default branch flagged in the reason), reset --hard, clean -f*, branch -D, checkout/restore discarding changes (`.`/`--`), rebase on shared branches, filter-branch/filter-repo, gc --prune=now, reflog expire | ask |
| fetchExec | Download and run | curl/wget/iwr/irm piped to sh/bash/zsh/python/node/iex, bash <(curl …) | ask |
| docker | Docker | system prune, volume rm/prune, image prune -a, rm -f with many containers, compose down -v | ask |
| database | Database | DROP DATABASE/TABLE/SCHEMA, TRUNCATE, DELETE without WHERE (in psql/mysql/sqlite -c/-e), migrate:fresh/reset, prisma migrate reset, db:drop, rails db:reset | ask |
| publish | Publishing and deploy | npm/pnpm/yarn publish, cargo publish, gem push, twine upload, vercel --prod, gh release create, docker push | ask |
| system | Processes and system | sudo, kill -9 -1 / killall / pkill without a narrow pattern, shutdown/reboot/halt, launchctl unload/bootout, systemctl stop/disable, Stop-Computer, Restart-Computer | ask |
| custom | Custom rules | user patterns (prefix or regex, like the test queue), each with its own action | per rule |

- Per-category action: allow / ask / deny. Per-rule override inside a category.
- Changing `disk` or `sensitive` to allow needs a confirmation dialog.
- Per-project override: inherit, or category actions and extra rules for that project.
- Guard default: on. Release notes explain it adds a hook to each account's Claude settings.
- Deny/ask reasons are short and actionable for the model ("ClaudeDeck guard (Git): force push
  is set to ask. Ask the user before force-pushing."); the user sees a `systemMessage`.
- Activity log: the last 200 guard decisions (time, tab, category, rule, action, command
  excerpt) in memory, shown in the guard settings section; a notice toast on deny.

## Settings redesign (Discord style)

- Full-window settings view (Esc or close button returns), left navigation, right content.
- Sections: Accounts, Claude and permissions, Command guard, Test queue, Usage and menu bar,
  General, About. Deep links: other parts of the app open settings at a section.
- Keyboard: arrow keys in the nav, Esc closes; accessible landmarks; remembers the last section.
- Existing sections move as they are (no behaviour change); the guard section is new.

## Testing

- Evaluator tables (hundreds of command strings per category, macOS/Linux/Windows forms,
  compound commands, wrappers, quoting, false positives such as `git push`, `rm -rf node_modules`,
  `rm -rf dist`, `docker ps`, `echo "rm -rf /"`, `grep DROP`), path rules for file tools,
  per-project and per-rule resolution. Pure functions only.
- Hook script and server: sentinel-only integration tests (fake server, `echo GUARD-SENTINEL`).
- No test ever runs a destructive command.

## Phases

1. Wait for the permission-mode work to land (it edits settings and project dialog).
2. In parallel: (a) settings redesign (renderer only: SettingsDialog, PreferenceSections split
   into section components, navigation); (b) guard backend (shell module move, evaluator, rules,
   hook generalisation + migration, server route, settings model + IPC, activity log).
3. Guard settings section + project override UI in the new layout; locales.
4. Code review and security review; release.
