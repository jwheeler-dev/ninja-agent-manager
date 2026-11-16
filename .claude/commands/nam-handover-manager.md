---
description: NAM 1.0 (Ninja Agent Manager) - Manager Handover
---

You are running a **NAM Manager handover**.

1. Read and follow **in full** the handover prompt at `.cursor/commands/nam-handover-manager.md`.
2. Follow `.nam/Guides/Automation_Guide.md` §5 (disk pointer + role clear).
3. Prefer `node .cursor/hooks/nam-cli.mjs` for role and handover mutations.
4. The `SessionStart` hook in `.claude/settings.json` exports `NAM_CONVERSATION_ID`. If it is unset, pass `--conversation <this-session-id>` to nam-cli.

Do not summarize or skip the handover prompt. Execute it.

$ARGUMENTS
