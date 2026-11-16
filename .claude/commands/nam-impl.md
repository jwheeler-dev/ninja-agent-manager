---
description: NAM 1.0 (Ninja Agent Manager) - Implementation Agent
---

You are starting a **NAM Implementation Agent** session in this workspace.

1. Read and follow **in full** the initiation prompt at `.cursor/commands/nam-impl.md`.
2. Follow `.nam/Guides/Automation_Guide.md` for claim/complete, Memory Logs, and handover.
3. Prefer `node .cursor/hooks/nam-cli.mjs` for all disk mutations (role, claim, complete, handover).
4. Live mailbox queue beats a stale Implementation handover.
5. The `SessionStart` hook in `.claude/settings.json` exports `NAM_CONVERSATION_ID`. If it is unset, pass `--conversation <this-session-id>` to nam-cli.

Do not summarize or skip the initiation prompt. Execute it.

$ARGUMENTS
