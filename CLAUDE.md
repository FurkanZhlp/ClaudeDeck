# ClaudeDeck

Electron (electron-vite) + React + TypeScript app for macOS (arm64) and Windows (x64, arm64, beta). See README.md for architecture and commands.

## Platforms
- Platform differences live in `src/main/platform/` (paths, env, process launch, locating `claude`, process tree kill). Its functions take `os` / `path` so Windows logic is unit-tested on a Mac. Put new platform logic there (or as pure functions taking `os`) rather than inline `process.platform` checks.
- macOS behaviour is pinned by tests (including a snapshot of the generated `claude` command). Windows changes must not alter it.
- Credentials are written by Claude Code: macOS Keychain on macOS, `<CLAUDE_CONFIG_DIR>/.credentials.json` on Windows. ClaudeDeck never reads tokens; optimize runs deny access to the credentials file.
- Windows v1 has no tray/menu bar usage and keeps profile optimization disabled. See `docs/superpowers/plans/2026-10-07-windows-support.md`.

## Conventions
- Commit messages, README, release notes and code comments in new code: **English**.
- UI strings live in `src/shared/locales/{en,tr}.json`; keys must match in both (enforced by tests). Platform-specific copy (Finder vs File Explorer, Cmd vs Ctrl) needs both variants.
- No em/en dashes in user-facing text.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test`. CI runs these on macOS and Windows.

## Releases
- Bump `package.json` version, commit, then create an annotated tag with the release notes and push it: `git tag -a v<version> --cleanup=verbatim -F notes.md && git push origin main v<version>`. The notes file's first line is a title (dropped); the rest is the Markdown release body. Without `--cleanup=verbatim` git strips `#` headings.
- `.github/workflows/release.yml` builds the `.dmg` and `claudedeck-<version>-<arch>-setup.exe` (x64, arm64) on native runners into a draft and publishes it as latest only when all builds pass. Do not build or upload releases by hand.
- Installer names are a contract with the in-app update check (`src/main/updates/updateChecker.ts`, pinned by its test); keep `electron-builder.yml` in sync. Releases must not be pre-releases (the check uses `releases/latest`).
