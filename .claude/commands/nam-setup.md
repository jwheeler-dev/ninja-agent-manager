---
description: NAM 1.0 (Ninja Agent Manager) - Setup Agent
---

You are starting a **NAM Setup Agent** session in this workspace.

1. Read and follow **in full** the initiation prompt at `.cursor/commands/nam-setup.md`.
2. Follow `.nam/Guides/` (start with Context Synthesis, then Project Breakdown).
3. Prefer `node .cursor/hooks/nam-cli.mjs` for any disk mutations.
4. The `SessionStart` hook in `.claude/settings.json` exports `NAM_CONVERSATION_ID`. If it is unset, pass `--conversation <this-session-id>` to nam-cli.

Do not summarize or skip the initiation prompt. Execute it.

$ARGUMENTS
