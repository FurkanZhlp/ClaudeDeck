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

- Memory dir for a project = `<accountConfigDir>/projects/<encode(project.path)>/memory/`.
- When a project's account or path changes, ClaudeDeck moves the memory dir to the new location
  before any new tab starts. If the destination already has files, files are merged and
  conflicting names get a `-moved-<timestamp>` suffix; nothing is deleted.
- Notes panel (right side, toggled from the session tab bar) lists `MEMORY.md` first, then other
  `.md` files by name; renders Markdown (react-markdown + remark-gfm, no raw HTML); live updates
  via a file watcher; "Open in editor" and "Show in Finder".

## 5. ClaudeDeck MCP server

- Streamable HTTP MCP server in the main process on `127.0.0.1`, preferred port 47821 with
  fallback to a random free port, bearer token generated once and stored in `config.json`.
- Registered as `mcpServers.claudedeck` (`type: "http"`, url, `Authorization` header) in every
  account's `.claude.json` on app start and before every Claude tab.
- Tools:
  - read: `list_accounts`, `list_projects`, `get_project` (by id or by path, so Claude can find
    the project for its cwd), `list_sessions`, `list_notes`, `read_note`
  - write: `write_note`, `create_project`, `open_session`
  - no deletion tools.
- Requests without the token, or from a non-loopback address, are rejected.

## Testing

- Unit: import (categories, path rewrite, backups, diff, settings merge), guidelines install and
  versioning, memory move/merge, MCP tools and auth.
- E2E (Playwright, isolated user data): onboarding steps up to sign-in, notes panel rendering.
- Manual: optimize run with a real account.
