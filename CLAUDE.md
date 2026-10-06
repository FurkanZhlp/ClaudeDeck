# ClaudeDeck

Electron (electron-vite) + React + TypeScript macOS app. See README.md for architecture and commands.

## Conventions
- Commit messages, README, release notes and code comments in new code: **English**.
- UI strings live in `src/shared/locales/{en,tr}.json`; keys must match in both (enforced by tests).
- No em/en dashes in user-facing text.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test`.
- Releases: bump `package.json` version, `pnpm build:mac`, `gh release create v<version> dist/*.dmg` (not a pre-release, the in-app update check uses `releases/latest`).
