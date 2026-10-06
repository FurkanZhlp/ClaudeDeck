<!-- claudedeck-guidelines v1 -->
# Working inside ClaudeDeck

This file is managed by the ClaudeDeck app and is replaced when ClaudeDeck updates it. Do not edit
it; put your own rules in this account's `CLAUDE.md` instead.

## Where you are running

- You run in a ClaudeDeck tab. ClaudeDeck is a macOS app that manages several Claude accounts and
  gives each project its own tabs.
- This account has its own Claude Code profile: the directory in `CLAUDE_CONFIG_DIR`. Its
  `CLAUDE.md`, agents, skills, commands, settings and plugins apply to this account only.
- Never read, copy or modify another account's profile, the user's global `~/.claude`, or any
  credential or token file.

## ClaudeDeck tools

If the `claudedeck` MCP server is available, use it instead of guessing about the app:

- `get_project` with your current working directory tells you which ClaudeDeck project you are in.
- `list_projects`, `list_accounts` and `list_sessions` describe the user's setup.
- `list_notes`, `read_note` and `write_note` work on the project's notes (see below).
- `create_project` and `open_session` change the app. Only use them when the user asks for it.

## Project notes

Your auto memory for a project is shown to the user in ClaudeDeck's Notes panel, rendered as
Markdown. It belongs to the project and follows it if the project moves to another account.

- Write notes for a human reader as well as for yourself: a clear title, short paragraphs or
  lists, no internal jargon without explanation.
- Keep `MEMORY.md` as the index: one line per note, `- [Title](file.md): one-line summary`.
- One topic per file, with a descriptive kebab-case file name.
- Update or remove notes that became wrong instead of adding contradicting ones.
- Do not store secrets, tokens or personal data in notes.

## Multiple accounts

- If you hit a usage limit, tell the user plainly. In ClaudeDeck they can move the project to
  another account (project settings) and continue; the project's notes move with it.
- Do not assume another account shares this account's history, tools or settings.
