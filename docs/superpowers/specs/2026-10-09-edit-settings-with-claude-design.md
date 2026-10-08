# Edit settings with Claude

Date: 2026-10-09
Status: Approved (target 0.6.0)

## Goal

Nobody wants to write regexes or hunt for the right switch. In Settings, "Edit with Claude" opens
a window where the user says what they want in plain words; the user's own Claude (one of their
ClaudeDeck accounts) proposes concrete settings changes; the user reviews and applies them.
Designed as a general mechanism so every settings section can take part.

## UX

1. A "Claude ile düzenle" button in the settings view header, visible on every section.
   Contextual entry points next to rule editors (guard custom rules, test queue patterns) open the
   same window pre-scoped to that section.
2. Modal window: title "Ne yapmak istiyorsunuz?", a multi-line text field, suggestion chips that
   depend on the current section (for example "Docker silmelerinde bana sor", "Prod deploy
   komutlarını engelle", "pytest'i kuyruğa al"), and a small account selector (default: the account
   of the selected project; remembers the last choice).
3. While Claude works: short animated status lines in the optimize "moments" style ("Ayarları
   inceliyor", "Kuralı örneklerle deniyor"), one at a time, plus Cancel.
4. Proposal view: plain-language summary of each change (section, what changes from what to
   what), Claude's one-sentence reason, the examples it tested with their results (guard decisions,
   test queue classification), risk notes (e.g. relaxing Disk ve sistem), buttons Uygula / Vazgeç,
   and a follow-up field ("Şunu da ekle") that continues the same conversation.
5. After applying: the window closes, settings navigate to the changed section and highlight the
   changed rows briefly; a toast offers Geri al (undo restores the previous values).

## Architecture

- Runs the user's Claude headless, like profile optimization: `claude -p` with the chosen
  account's CLAUDE_CONFIG_DIR, an appended system prompt (resources/claudedeck/settings-assistant-
  prompt.md), `--tools ""` (no built-in tools: no shell, files or web), `--strict-mcp-config` with
  only the ClaudeDeck MCP server, a dedicated short-lived `settings-assistant` token scope, no
  session persistence, a model the account can use (default: the account default; a fast model is
  enough), stream-json output for status updates. Follow-ups resume the same session id.
- MCP tools (settings-assistant scope only):
  - `get_settings_overview()`: sections, what each controls, current values (secrets excluded).
  - `get_section_schema(section)`: allowed fields, enums, ranges, rule ids with labels.
  - `test_guard(command | path, tool?, projectId?)` and `classify_test_command(command,
    projectId?)`: evaluate strings with the real evaluators (never executed).
  - `propose_changes({ summary, reason, changes: [{ section, scope: global|project, projectId?,
    patch }], examples: [{ input, expected }] })`: validated with the same validators the IPC
    setters use; invalid proposals return a precise error so Claude can retry. Valid proposals are
    shown to the user; the tool returns after the user decides (apply, refine, cancel) so the model
    can respond to a refinement.
  - `ask_user(question)`: one short clarifying question shown in the window (optional, limited to
    two per run).
- Sections in v1: command guard (categories, rule overrides, custom rules, project overrides),
  test queue (mode, limits, patterns, project overrides), Claude permissions (default mode, allow
  bypass toggle; bypass still requires the usual confirmation), usage display and menu bar,
  general (launch at login, language). Accounts are out of scope (no credentials, no deletion).
- Applying always goes through the existing repository setters and confirmations (Disk ve sistem
  or Hassas dosyalar to allow, bypass). Undo stores the previous values of the touched fields.

## Security

- The model never applies anything; only the user's click does. All patches are validated by the
  same code as manual edits; regex safety checks apply.
- No built-in tools and only the settings-assistant MCP tools; the token is issued per run,
  scoped to that run, revoked at the end; it cannot reach tab tools (notes, projects, queue
  cancel).
- The user's request and current settings are sent to Anthropic through the user's own account;
  the window says so in one line.
- Output shown to the user is plain text; no HTML.

## Testing

- Unit: validators for proposals, MCP tool scoping, patch diff rendering, undo.
- Integration: a fake claude process (scripted stream-json) driving the MCP tools end to end.
- Manual: real run with a small request per section.
