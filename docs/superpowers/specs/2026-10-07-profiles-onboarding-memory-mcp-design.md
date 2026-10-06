# Account profiles, onboarding, project notes and ClaudeDeck MCP

Date: 2026-10-07
Status: Approved

## Goals

1. Each ClaudeDeck account gets a full Claude Code profile (CLAUDE.md, agents, skills, commands,
   output styles, settings, plugins) without ever writing to the user's global `~/.claude`.
2. First-run onboarding offers to import the user's Claude setup and to optimize it with the
   ClaudeDeck recommended structure, by running the user's own Claude with our system prompt.
3. ClaudeDeck ships versioned guidelines that every account's CLAUDE.md includes.
4. Project memory belongs to the project (not the account) and is browsable in the app.
5. Claude can understand and drive ClaudeDeck through a local MCP server.

## Decisions (from the user)

- Import is a one-time copy plus an explicit "re-import" action. No live sync.
- One profile per account (the account's `CLAUDE_CONFIG_DIR` is its profile).
- Project memory is bound to the project.
- All five parts ship together.

## Verified facts (Claude Code 2.1.282)

- `@relative/path.md` imports work in the account-level `CLAUDE.md` (relative to the file).
- Auto memory lives in `<configDir>/projects/<cwd with non-alphanumerics as "-">/memory/`.
- If that memory directory is a symlink, Claude asks for permission on every memory write.
  A real directory is written without prompts. **So memory is never symlinked; it is moved.**
- `claude auth login` leaves `hasCompletedOnboarding` unset (handled already).

## 1. Account profile

Profile = the account's config dir. App-managed files live under `<configDir>/claudedeck/`.

Import sources: `~/.claude` (if present), another ClaudeDeck account, or nothing.

Imported categories (each optional, user picks in the UI):

| Category | Source items |
| --- | --- |
| instructions | `CLAUDE.md` |
| agents | `agents/` |
| skills | `skills/` |
| commands | `commands/` |
| outputStyles | `output-styles/` |
| settings | `settings.json` (merged: imported keys override, account-only keys kept) |
| plugins | whole `plugins/` directory (APFS clone, so no extra disk use) |

- Copy with APFS clones (`cp -cR`), falling back to a normal recursive copy if cloning fails
  (different volume, non-APFS).
- After copying `plugins/`, absolute paths that start with the source root in
  `installed_plugins.json` and `known_marketplaces.json` are rewritten to the account dir.
- Never copied: `.claude.json`, credentials, `projects/`, `sessions/`, `history.jsonl`, caches,
  `todos/`, `shell-snapshots/`, `statsig`/telemetry, backups.
- Before overwriting anything, existing items are moved to
  `<configDir>/claudedeck/backups/<ISO timestamp>/`.
- Re-import computes a per-category diff (added / changed / removed file counts) so the UI can
  show what would change before applying.
- The global `~/.claude` is only ever read.

## 2. Guidelines

- Source: `resources/claudedeck/guidelines.md` (shipped with the app) with a front-matter-free
  first line `<!-- claudedeck-guidelines v<N> -->`.
- Installed to `<configDir>/claudedeck/guidelines.md` on app start and before every Claude tab.
- `CLAUDE.md` gets one line `@claudedeck/guidelines.md` appended if missing (file created if
  absent). User content is never otherwise edited by the app.
- When the installed version is older, the file is replaced and the renderer is told
  (`guidelinesUpdated` event with old/new version) to show a toast.

## 3. Onboarding wizard

Full-window flow shown when there are no accounts, and the import/optimize steps are also
offered after adding any later account:

1. Welcome.
2. Create account (name + colour) and sign in (existing animated sign-in flow, embedded).
3. Import: choose source and categories; shows counts (e.g. 21 agents, 56 skills, 46 plugins).
4. Optimize (optional): runs `claude` in the account profile directory with
   `--append-system-prompt "<resources/claudedeck/optimize-prompt.md>"` and an initial user
   message. The session is an embedded terminal; Claude asks permission for each edit.
5. Done.

Settings > Accounts > account row > "Profile" section: re-import (diff preview), run optimize
again, open profile folder in Finder.

## 4. Project notes

- Memory dir for a project = `<accountConfigDir>/projects/<encode(key)>/memory/`, where `key` is
  the memory key Claude Code uses (verified on 2.1.282): the `realpath` of the project folder,
  then the nearest ancestor (or itself) that contains a `.git` entry, directory or file, so
  worktrees and submodules count. Outside a repository the key is the realpath itself. A
  project at `<repo>/packages/web` therefore shares memory with every project inside `<repo>`.
- `encode(key)`: every non-alphanumeric character becomes `-`. If the result is longer than 200
  characters it becomes `encoded.slice(0, 200) + '-' + Math.abs(javaHash(key)).toString(36)`,
  where `javaHash` is `h = (h << 5) - h + charCode; h |= 0` over the raw (unencoded) key.
- When a project's account or path changes and the memory dir differs, ClaudeDeck moves it to
  the new location. If the destination already has files, files are merged and conflicting
  names get a `-moved-<timestamp>` suffix; identical duplicates are dropped; nothing is lost.
  - If the project has a running terminal the move is deferred (Claude may still write to the
    old folder) and applied the next time the project is prepared while nothing runs. The
    pending source is kept in memory only.
  - If another project of the old account resolves to the same key, the notes are copied, not
    moved, so that project keeps its memory.
- Stateless merge: before every Claude tab starts, and whenever the notes panel lists or
  watches a project, ClaudeDeck prepares the project's memory: it applies a deferred move and
  merges notes left under the same key in other accounts' config dirs into the current one,
  but only from accounts that have no project with that key. Nothing happens while the project
  runs.
- Safety: notes are only opened when they are regular `.md` files whose realpath stays inside
  the memory dir. Writes and relocations refuse (INVALID) when the memory dir, its key folder
  or the destination is a symlink or resolves outside the account's `projects/` folder. A
  symlinked source memory folder is the user's own setup and is never moved.
- Notes panel (right side, toggled from the session tab bar) lists `MEMORY.md` first, then other
  `.md` files by name; renders Markdown (react-markdown + remark-gfm, no raw HTML); live updates
  via a file watcher; "Open in editor" and "Show in Finder".

## 5. ClaudeDeck MCP server

- Streamable HTTP MCP server in the main process on `127.0.0.1`, preferred port 47821 with
  fallback to a random free port. Stateless per request.
- Registered as `mcpServers.claudedeck` in every account's `.claude.json`:
  `{ "type": "http", "url": ..., "headers": { "Authorization": "Bearer ${CLAUDEDECK_MCP_TOKEN}" } }`.
  The header is a literal placeholder that Claude Code expands from the claude process env, so no
  secret is ever written to disk. `unregisterMcpInConfig` removes the entry again.
- Per-session scoped tokens: when a Claude tab starts, the main process issues a fresh token
  (32 random bytes, hex) bound to `{ sessionId, projectId, accountId }` and passes it only to that
  claude process as `CLAUDEDECK_MCP_TOKEN`. Tokens live in memory only; restarting a tab replaces
  its token, closing it revokes it, quitting the app revokes all. Shell tabs get no token.
- Scoping (enforced in the tools, per token):
  - `list_accounts`: only the caller's own account `{ id, name }`, no emails.
  - `list_projects`, `get_project` (by id or by path, so Claude can find the project for its
    cwd): only projects of the caller's account.
  - `list_sessions`, `list_notes`, `read_note`, `write_note`: `projectId` is optional and defaults
    to the tab's own project; any other project is refused with "Not allowed".
  - Note quota: at most 200 notes and 5 MB in total per project, 1 MB per note.
- Confirmation: `create_project` and `open_session` change the app, so they ask the user first
  (a confirmation request names the requesting tab). Declining, closing the prompt or a timeout
  returns "The user declined." as a normal result. One pending request per tab.
  - `create_project`: the account is always the caller's; the path must exist and be a
    directory, it is stored as its realpath, and `/`, the home folder itself and system folders
    (`/System`, `/Library`, `/bin`, `/sbin`, `/usr`, `/etc`, `/private/etc`, `/Applications`)
    are refused.
  - `open_session`: the project must belong to the caller's account; the new tab is selected in
    the UI but not started.
- No deletion tools.
- Request guards: non-loopback peers and any request with an `Origin` header get 403 (browsers
  always send Origin, Claude Code does not), `OPTIONS` gets 405, a missing or unknown token gets
  401, and the SDK's DNS rebinding protection checks `Host`. Tool calls are rate limited to 60 per
  minute per tab.

## Testing

- Unit: import (categories, path rewrite, backups, diff, settings merge), guidelines install and
  versioning, memory move/merge, MCP tools and auth.
- E2E (Playwright, isolated user data): onboarding steps up to sign-in, notes panel rendering.
- Manual: optimize run with a real account.
