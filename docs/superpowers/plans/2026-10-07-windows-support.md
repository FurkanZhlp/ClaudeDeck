# Windows support plan

Date: 2026-10-07
Status: Approved (phased)

## Decisions

- Platform-specific code lives in `src/main/platform/` (posix + win32 implementations, pure
  functions take `os` / `path` so Windows logic is unit-testable on a Mac). macOS behaviour stays
  byte-for-byte identical (snapshot test on the generated claude command).
- On Windows `claude.exe` is spawned directly (no login shell). Shell tabs: `pwsh.exe`, then
  Windows PowerShell, then `%ComSpec%`, with `-NoLogo`.
- Account isolation: Claude Code on Windows stores credentials in `<CLAUDE_CONFIG_DIR>/.credentials.json`,
  so `CLAUDE_CONFIG_DIR` isolates accounts like on macOS.
- Strip `ANTHROPIC_PROFILE` and federation env vars on both platforms (approved).
- Optimize on Windows stays behind a feature flag until the `//c/...` deny rules are verified on a
  real machine. `PowerShell` tool is always disallowed in optimize runs.
- Windows system tray is a later phase (4). v1 Windows hides the menu bar settings.
- v1 ships unsigned (SmartScreen note in README); apply to SignPath later.

## Verified Claude Code facts (Windows)

| Topic | Fact |
|---|---|
| Install | Native installer `irm https://claude.ai/install.ps1 \| iex`, WinGet `Anthropic.ClaudeCode`, npm `@anthropic-ai/claude-code` (x64, arm64). |
| Binary | Native: `%USERPROFILE%\.local\bin\claude.exe`. npm: `claude.cmd` / `claude.ps1` shims. |
| Shell | Git for Windows optional; Bash tool uses Git Bash when found (`CLAUDE_CODE_GIT_BASH_PATH`, `C:\Program Files\Git`, `C:\Program Files (x86)\Git`, next to `git` on PATH), else PowerShell tool. |
| Credentials | `.credentials.json` in the config dir; Credential Manager not used. |
| statusLine | Runs via Git Bash if present, else PowerShell. Use `/` in paths. `powershell -NoProfile -File C:/.../statusline.ps1` works under both. |
| Permission rules | Windows paths are normalized to POSIX before matching: `C:\Users\alice` becomes `/c/Users/alice`; absolute rules are `//c/...`. |
| CLI | `--append-system-prompt-file`, `--settings <file\|json>`, `--mcp-config`. `claude auth status` JSON has `configDirectory` (2.1.268+). |
| Project key | Not documented for Windows; expected `C:\Users\x\p` -> `C--Users-x-p`. Verify on a real machine. |

## Platform-dependent spots

### Process, env, locating claude
- `src/main/env/shellEnv.ts` `withFallbackPath` (`;` separator, fallbacks `%USERPROFILE%\.local\bin`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`), `sanitizeEnv` / `buildSessionEnv` (case-insensitive env keys on Windows, merge `Path`/`PATH`), `claudeCommand` (no shell on Windows: delete credential vars from env object, spawn `claude.exe`), `defaultShell`, `resolveShellEnv` (no login shell; normalized `process.env` + fallback PATH).
- `src/main/accounts/accountService.ts` `run` (absolute path, `windowsHide`; `.cmd` cannot be spawned without a shell), `claudeAvailable` (locator: PATH + PATHEXT, prefer `.exe`, known locations, parse npm shim target), `transcriptPath` (reuse `encodeProjectKey` from `notes/memoryPath.ts`), `destroy` (close watchers first, `rmSync` with `maxRetries`).
- `src/main/ipc.ts` pty start + login: get `{file,args,env}` from the platform layer.
- `src/main/ipc.ts` / `src/main/state/repository.ts` `isAbsolute`: reject UNC (`\\server\share`, `\\wsl$`) and drive-less paths on Windows in v1.
- `src/main/pty/ptyManager.ts`: absolute file; ConPTY automatic; node-pty prebuilds for win32 x64/arm64.
- `src/main/usage/usagePoller.ts`, `src/main/optimize/optimizeManager.ts` `defaultKillTree`: `taskkill /PID n /T /F` on Windows; spawn with `detached:false`, `windowsHide:true` (detached opens a console).
- `optimizeManager.ts` `buildClaudeArgs`: 32K command line limit, pass prompt with `--append-system-prompt-file` from a temp dir outside the profile, removed after the run.
- `optimizeManager.ts` `DISALLOWED_TOOLS`: add `PowerShell` (security).
- `optimizeManager.ts` `profileDenyRules`: produce `//c/Users/<u>/AppData/Roaming/ClaudeDeck/accounts/<id>/.credentials.json` (security; current code would produce a non-matching `/C:\...`).
- `src/main/mcp/server.ts`: fall back to a random port on `EACCES` too (Hyper-V reserved ranges).

### File system, paths, Claude file formats
- `src/main/usage/statusline.ts`: new `statusline.ps1` template; command `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '<C:/.../statusline.ps1>'`; `OURS` pattern `claudedeck[\\/]statusline\.(sh|ps1)`; UTF-8 stdin, BOM-less atomic write; chain the original statusline via Git Bash (`bash -c`) if found at install time, else `powershell -Command`.
- `usageWatcher.ts`, `notes/notesIpc.ts` `fs.watch`: open handles block rename/rm on Windows; close watchers before relocate/destroy; call `usage.sync()` on account removal.
- `src/main/profile/importer.ts`: `cloneCopy` (`cp -cR`) darwin only, else `fs.cp`; `safeSymlink` (junction for dirs, copy fallback on EPERM); junk list adds `Thumbs.db`, `desktop.ini`; `within` and `rewritePaths` case-insensitive with both separators.
- `renameSync` sites (`importer.ts`, `optimizeManager.ts`, `notes/notesStore.ts`, `mcp/register.ts`, `state/jsonStore.ts`, `profile/guidelines.ts`, `accountService.ts`): `renameWithRetry` (EPERM/EBUSY/EACCES backoff).
- `notes/notesStore.ts` `isValidNoteName`: on Windows also reject `<>:"|?*`, reserved names `CON PRN AUX NUL COM1-9 LPT1-9`, trailing dot/space (security: names come from Claude via MCP).
- `notes/memoryPath.ts`, `notes/notesSync.ts`: normalize drive letter case for string comparisons.
- `mcp/tools.ts` `BLOCKED_ROOTS`: add `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, and drive roots.
- File modes (`0o600/0o700/0o755`): no effect on Windows; `%APPDATA%` ACL is the boundary (documented decision).

### Electron shell, menu, tray, lifecycle
- `src/main/index.ts` window: `titleBarStyle: 'hidden'` + `titleBarOverlay {color, symbolColor, height: 44}`, sync on `nativeTheme` `updated`, set `backgroundColor`.
- Login item: `setLoginItemSettings({ openAtLogin, args: ['--launched-at-login'] })`, detect hidden start from `process.argv` (`wasOpenedAtLogin` is macOS only).
- `app.dock` already optional-chained; `setAppUserModelId` must equal NSIS `appId` (`com.furkanzhlp.claudedeck`).
- `src/main/menu.ts`: `Menu.setApplicationMenu(null)` on Windows (avoid Ctrl+C accelerator clash with the terminal); Ctrl+, in renderer; "Check for updates" and "About" in settings.
- `src/main/tray/*`: disabled on Windows in v1 (phase 4).
- `src/main/updates/updateChecker.ts`: report an update only if the release has an asset for this platform and arch.

### Renderer and copy
- Caption buttons (~138px) cover the top right on Windows: `<html data-platform>` + `--titlebar-inset-right` padding in `SessionTabs.tsx`, `LoginDialog.tsx`, `RunScreen.tsx`, `OnboardingFlow.tsx`.
- `Sidebar.tsx`, `ProjectDialog.tsx`: split paths on `/[\\/]/`.
- `terminal/terminalPool.ts`: fonts add `"Cascadia Mono", Consolas`; links on Ctrl+click; Ctrl+C copies when there is a selection else sends SIGINT; Ctrl+V paste; Ctrl+Shift+C/V.
- Locales: platform variants (install command `irm https://claude.ai/install.ps1 | iex`, "Show in File Explorer" / "Dosya Gezgini'nde göster", "Ctrl+Enter"); hide menu bar copy on Windows.
- `PreferenceSections.tsx`: hide menu bar section on Windows.
- `preload` / `shared/api.ts`: expose `app.platform`.

### Build and docs
- `electron-builder.yml`: `win` + `nsis` blocks, `build/icon.ico` (16/32/48/256).
- `package.json`: `build:win`; make `pricing:update` Node-only.
- `scripts/fix-permissions.mjs`: exit early on win32.
- `.gitattributes`: `* text=auto eol=lf`.
- README / CLAUDE.md: Windows install, SmartScreen, credentials file, release flow.
- Tests: `posixOnly` / `windowsOnly` helpers (`it.skipIf` / `it.runIf`); expected paths via `join`.

## Phases

### Phase 0: foundation (one agent, blocks the rest)
1. `.gitattributes`.
2. `src/main/platform/{types,index,constants,env,launch,processTree,paths,fs}.ts` with the posix implementation filled (exact move of current behaviour); win32 functions may throw "not implemented".
3. Route call sites through the platform API with no macOS change: `ipc.ts` (pty start, login), `usagePoller.ts` (spawn, killTree), `optimizeManager.ts` (spawn, killTree, `permissionRulePath` in `profileDenyRules`), `accountService.ts` (`run`, locator).
4. `.github/workflows/ci.yml`: matrix `macos-latest`, `windows-latest`: install, lint, typecheck, test; Windows `continue-on-error: true` until phase 2 ends.

Acceptance: Mac lint/typecheck/test green; snapshot test of the claude command unchanged.

### Phase 1: three parallel streams
- A (backend) process and env: win32 `env`, `claudeLocator`, `launch`, `processTree`; `shellEnv.ts`, `accountService.ts`, `ptyManager.ts`, `mcp/server.ts`.
- B (backend) Claude file formats and security rules: `usage/statusline.ts`, new `usage/statuslineScript.ts`, `usageWatcher.ts`, `usageCommand.ts` (CRLF), `optimizeManager.ts`, `profile/importer.ts`, `platform/paths.ts` `permissionRulePath`.
- C (desktop/frontend) Electron shell, renderer, i18n: `index.ts`, `menu.ts`, `tray/*`, `updateChecker.ts`, preload, `shared/api.ts`, renderer files listed above, locales.

### Phase 2: three parallel streams
- D (backend + security review) notes, MCP tools, atomic writes: `notes/*`, `mcp/{tools,register}.ts`, `state/jsonStore.ts`, `profile/guidelines.ts`, `platform/{paths,fs}.ts` win32 additions.
- E (devops) packaging and release: `electron-builder.yml`, `package.json`, `build/icon.ico`, `.github/workflows/release.yml` (draft release; jobs mac-arm64 on macos-latest, win-x64 on windows-latest, win-arm64 on windows-11-arm; publish at the end), scripts.
- F (qa-test) make Windows CI green: shared test helpers, test files not owned by A to D; module owners fix their own failures.

### Phase 3: integration and quality gate
code-reviewer, security (deny rules, PowerShell tool, note names, MCP blocked roots, credentials never imported), manual QA on real Windows (x64, arm64 if possible), tech-writer for README and CLAUDE.md.

### Phase 4 (later): Windows system tray
`.ico` tray icon, percentage in tooltip, popover above the taskbar (`popoverBounds` picks above or below by work area), settings visible on Windows.

## Manual QA checklist (real Windows)
- NSIS install/uninstall keeps data; SmartScreen flow.
- `CLAUDE_NOT_FOUND` and detection with native, npm and WinGet installs.
- Two accounts, login, `configDirectory` per tab, concurrent tabs, resume.
- Shell tab opens pwsh/powershell with `$env:CLAUDE_CONFIG_DIR` set.
- Notes panel folder matches Claude's (`C--Users-...`).
- Profile import from `%USERPROFILE%\.claude`.
- Optimize: reading `.credentials.json` is denied; PowerShell tool disabled.
- Usage poller and statusline with and without Git Bash; existing statusline chained.
- MCP tools from a tab, account removal, launch at login, caption buttons in light and dark, Ctrl+C / Ctrl+V / Ctrl+click in the terminal.

## Risks
- Credentials file inside the optimize `--add-dir` scope: deny rule format must be verified on real Claude (optimize flag off until then).
- Project key encoding on Windows is undocumented.
- PowerShell statusline start-up cost (0.3 to 0.7 s) and `AllSigned` GPO (fallback `-EncodedCommand`).
- ConPTY may re-wrap the long login URL (`src/shared/loginProgress.ts`); join lines when parsing if needed.
- npm shim targets and WinGet locations change between versions.
- AV/indexer EPERM/EBUSY: retry helpers.
- Unsigned builds: SmartScreen and possible Defender false positives.
- Out of scope v1: WSL/UNC project folders, Windows tray, auto-update.
