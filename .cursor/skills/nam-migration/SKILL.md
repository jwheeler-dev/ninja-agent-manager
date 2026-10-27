---
name: nam-migration
description: Guide for Ninja Agent Manager (NAM) layout and migration notes from legacy APM paths.
---
# Ninja Agent Manager (NAM)

This repo uses **Ninja Agent Manager (NAM)**, not APM.

- Root: `.nam/` (layout folders Capitalized: `Guides/`, `Mailbox/`, `Memory/`, `Runtime/`, `Scripts/`)
- Commands: `/nam-setup`, `/nam-manager`, `/nam-impl`, `/nam-handover-manager`, `/nam-handover-impl`
  - Cursor: `.cursor/commands/`
  - VS Code Copilot Chat: `.github/prompts/` (wrappers)
  - Continue: `.continue/prompts/` (wrappers)
  - Gemini CLI: `.gemini/commands/` (wrappers)
  - Claude Code: `.claude/commands/` (wrappers)
- CLI: `node .cursor/hooks/nam-cli.mjs …`
- Guides: `.nam/Guides/` (start with `Automation_Guide.md`)
- VS Code: `.vscode/settings.json` loads `.cursor/skills`; hooks in `.github/hooks/nam.json`

Legacy `.apm/` and `/apm-*` names are retired. If you see them in old logs, treat paths as under `.nam/` (e.g. `.nam/Memory/…`) and commands as `/nam-*`.
