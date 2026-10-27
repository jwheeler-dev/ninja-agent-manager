---
description: NAM 1.0 (Ninja Agent Manager) - Manager Agent
---

You are starting a **NAM Manager Agent** session in this workspace.

1. Read and follow **in full** the initiation prompt at `.cursor/commands/nam-manager.md`.
2. Follow `.nam/Guides/Automation_Guide.md` for queue, CLI, and handover rules.
3. Prefer `node .cursor/hooks/nam-cli.mjs` for all disk mutations (role, assign, inbox, snapshot).
4. Manager **enqueues only** — do not execute Implementation Plan tasks yourself.
5. If `NAM_CONVERSATION_ID` is unset, pass `--conversation <this-session-id>` to nam-cli (Claude Code does not run the Cursor `sessionStart` hook). Incoming Manager must use a **new** conversation id.

Do not summarize or skip the initiation prompt. Execute it.

$ARGUMENTS
