<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="ClaudeDeck icon">
</p>

<h1 align="center">ClaudeDeck</h1>

<p align="center">
  Assign multiple Claude Pro/Max accounts to your projects and open <code>claude</code> terminals that run with the right account.
</p>

<p align="center">
  macOS (Apple Silicon) and Windows (x64, arm64, beta)
</p>

<p align="center">
  <a href="https://github.com/FurkanZhlp/ClaudeDeck/releases/latest"><strong>Download the latest release</strong></a>
</p>

![Claude session](docs/screenshots/claude-session.png)

## Why

If you keep separate Claude accounts for personal and work use, switching between them in Claude Code means signing out and back in every time. In ClaudeDeck you assign an account to a project once, and every Claude tab you open in that project starts with that account. Projects on different accounts run side by side.

## Features

- **Multiple accounts:** each account uses its own isolated Claude Code config directory. Accounts never mix, and your existing `~/.claude` setup is left untouched.
- **Account rail:** switch accounts from colour-coded badges on the left; each account shows only its own projects and remembers the last project and tab you used.
- **Per-project account:** a project is a folder plus an account. Change the account and new tabs open with the new one.
- **Tabs:** as many Claude and plain Terminal tabs per project as you like. Background tabs keep running.
- **Resume per tab:** each Claude tab remembers its own conversation, so you can pick it up again after restarting the app.
- **Account usage:** a ring per account shows plan usage, with a pace tick that marks where you would be at an even rate. On macOS the usage can also sit in the menu bar.
- **Project notes:** read what Claude has written down about a project; notes follow the project when you move it to another account.
- **Profile import and optimization:** copy your existing `~/.claude` setup (or another account's) into an account, then let Claude tidy it up in a headless run.
- **ClaudeDeck MCP server:** Claude in a ClaudeDeck tab can read and write the project's notes, and can ask to create a project or open a tab, which you confirm in the app.
- **Launch at login.**
- **English and Turkish UI:** follows the system language by default, switchable in Settings.
- **Guided sign-in:** an animated, step-by-step sign-in screen instead of a raw terminal.
- **Update notifications:** the app tells you when a new release is out.

| Account isolation | Settings |
| --- | --- |
| ![Terminal](docs/screenshots/terminal.png) | ![Settings](docs/screenshots/settings.png) |
| **New project** | **Signed-out account warning** |
| ![New project](docs/screenshots/new-project.png) | ![Signed-out warning](docs/screenshots/signed-out.png) |

## Installation

ClaudeDeck needs [Claude Code](https://docs.claude.com/en/docs/claude-code) installed on the machine.

### macOS

Requirements: an Apple Silicon Mac and Claude Code:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

1. Download `claudedeck-<version>-arm64.dmg` from [Releases](https://github.com/FurkanZhlp/ClaudeDeck/releases/latest) and drag ClaudeDeck into Applications.
2. The app is not notarized by Apple yet, so macOS may block the first launch. If it does, run this once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/ClaudeDeck.app
   ```

### Windows (beta)

Requirements: Windows on x64 or arm64 and Claude Code, installed with any of these:

```powershell
irm https://claude.ai/install.ps1 | iex       # native installer (recommended)
winget install Anthropic.ClaudeCode            # WinGet
npm install -g @anthropic-ai/claude-code       # npm
```

1. Download `claudedeck-<version>-<arch>-setup.exe` for your architecture (`x64` or `arm64`) from [Releases](https://github.com/FurkanZhlp/ClaudeDeck/releases/latest) and run it. It installs for the current user only.
2. The installer is not code signed yet, so SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway**.

Windows support is new. Not yet available on Windows: the menu bar (system tray) usage view and profile optimization.

## Usage

1. Add an account in **Settings > Accounts**. A window runs `claude auth login`; sign in with that account in your browser.
2. Create a project with **+** in the sidebar: pick a folder and assign an account.
3. Open a tab with **+ Claude** or **+ Terminal** in the top bar.

Links in the terminal open with Cmd+click (Ctrl+click on Windows).

## How it works

Claude Code keeps its session and settings in the directory given by `CLAUDE_CONFIG_DIR`. ClaudeDeck creates an `accounts/<id>/` directory for each account and starts Claude with that variable:

- macOS: `~/Library/Application Support/ClaudeDeck/accounts/<id>/`
- Windows: `%APPDATA%\ClaudeDeck\accounts\<id>\`

On macOS the variable is passed on the command line again so your shell config (`.zshrc` and friends) cannot override it. On Windows `claude.exe` is started directly, without a shell. On both, credential variables such as `ANTHROPIC_API_KEY` and endpoint variables such as `ANTHROPIC_BASE_URL` are removed from Claude tabs, so every tab talks to Anthropic with its account's own sign-in.

Claude Code stores credentials itself: in the macOS Keychain on macOS, and in `.credentials.json` inside the account's config directory on Windows. ClaudeDeck never reads or stores tokens.

## Development

```bash
pnpm install
pnpm dev          # development mode
pnpm test         # unit tests (Vitest)
pnpm lint
pnpm typecheck
pnpm build:mac        # dist/claudedeck-<version>-arm64.dmg
pnpm build:win:x64    # dist/claudedeck-<version>-x64-setup.exe
pnpm build:win:arm64  # dist/claudedeck-<version>-arm64-setup.exe
```

Build each Windows architecture in its own run so the installer name includes the arch.

```
src/main      Electron main process: state store, account service, PTY manager, update check, IPC
src/main/platform  macOS and Windows differences (paths, env, process launch, locating claude)
src/preload   Narrow API exposed to the renderer (contextBridge)
src/renderer  React UI, xterm.js terminal pool
src/shared    Types, IPC contract, en/tr translations
docs/         Design, implementation plan, screenshots
```

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The Release workflow checks that the tag matches `package.json`, creates a draft release, builds the macOS `.dmg` and both Windows installers on native runners and uploads them. The draft is published as latest only when every build passes, so the in-app update check (`releases/latest`) never sees a half-filled release. Notes come from an annotated tag message, or are generated.

## Known limitations

- **Anthropic federation profiles:** if an active federation profile is configured in Claude Code's own profile files, it can take precedence over the account's `/login` session. ClaudeDeck removes the related environment variables (`ANTHROPIC_PROFILE` and friends) but does not touch profile files.
- **Custom endpoints:** `ANTHROPIC_BASE_URL`, Bedrock, Vertex and similar endpoint variables are removed on purpose, so a gateway set in your shell is not used in ClaudeDeck tabs.
- **Windows:** no menu bar (tray) usage and no profile optimization yet; installers are unsigned.

## Disclaimer

ClaudeDeck is an independent project and is not affiliated with Anthropic.
