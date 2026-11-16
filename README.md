# Ninja Agent Manager (NAM)

**NAM** is a disk-backed system for running multi-agent software projects with a clear human-in-the-loop workflow: a Manager plans and enqueues work; you open Implementation chats that claim and execute tasks; Memory Logs stay the source of truth.

It is built around a task queue, slash-command agents, and editor hooks that reduce copy-paste. The same `.nam/` tree works in **Cursor**, **VS Code (GitHub Copilot Chat, Continue, or Gemini CLI)**.

## How it works

1. **Manager** enqueues Task Assignment Prompts (TAPs) to agent mailboxes — it does **not** auto-run plan tasks.
2. **You** open (or reuse) the matching Implementation chat and run `/nam-impl`.
3. **Implementation** claims the next queued task, researches/debugs/implements in that same chat, writes a Memory Log, and reports completion.
4. **Manager** reviews by path (inbox / Memory Logs) and enqueues the next work.

```
Manager  --assign-->  .nam/Mailbox/<Agent>/  --claim-->  /nam-impl
                              |
                         Memory Logs
                              |
                         Manager inbox review
```

## Slash commands

| Command | Role |
|---------|------|
| `/nam-setup` | Setup Agent — rare; project breakdown and bootstrap |
| `/nam-manager` | Manager — enqueue and review only |
| `/nam-impl` | Implementation — claim queue; research, debug, and implement |
| `/nam-handover-manager` | Manager handover between chats |
| `/nam-handover-impl` | Implementation handover between chats |

Research and debug live in `/nam-impl`. There are no separate ad-hoc / research / debug entry points.

## Layout

```
.nam/
  Guides/           # Operating guides (start with Automation_Guide.md)
  Mailbox/          # Per-agent FIFO task queues
  Memory/           # Memory Logs and handovers
  Runtime/          # Roles, inbox, dispatch state
  Scripts/          # Export and maintenance helpers
  Implementation_Plan.md
  metadata.json
  README.md

.cursor/
  commands/         # Canonical nam-*.md slash-command prompts
  hooks/            # nam-cli, nam-lib, session/subagent hooks
  hooks.json        # Cursor lifecycle wiring
  skills/           # Agent skills (also loaded by VS Code)

.github/
  prompts/          # VS Code Copilot slash commands (wrappers)
  hooks/            # VS Code Copilot lifecycle wiring

.gemini/
  commands/         # Gemini CLI slash commands (wrappers)

.continue/
  prompts/          # Continue slash commands (wrappers)

.vscode/
  settings.json     # Load .cursor/skills in VS Code
  extensions.json
```

## CLI

Prefer the CLI for queue and role mutations:

```bash
node .cursor/hooks/nam-cli.mjs status
node .cursor/hooks/nam-cli.mjs assign --agent Agent_X --task-ref "Task X.Y - Title" --log <memory_log_path> --file tap.md
node .cursor/hooks/nam-cli.mjs queue list --agent Agent_X
node .cursor/hooks/nam-cli.mjs claim --agent Agent_X
node .cursor/hooks/nam-cli.mjs complete --agent Agent_X --log <path>
node .cursor/hooks/nam-cli.mjs inbox list
node .cursor/hooks/nam-cli.mjs inbox ack --all
node .cursor/hooks/nam-cli.mjs doctor
node .cursor/hooks/nam-cli.mjs handover register --agent Manager --file <numbered handover file>
node .cursor/hooks/nam-cli.mjs handover accept --agent Manager
node .cursor/hooks/nam-cli.mjs reconcile [--apply]
```

## Hooks

The same Node scripts in `.cursor/hooks/` run in Cursor, VS Code and Claude Code. Cursor wires them via `.cursor/hooks.json`, VS Code Copilot Chat via `.github/hooks/nam.json`, and Claude Code via `.claude/settings.json` (`SessionStart`, plus a `PreToolUse` hint that points `Grep`/`Glob` searches at `base ast query`).

| Hook | Purpose |
|------|---------|
| `sessionStart` / `SessionStart` | Bind conversation id; inject queue / handover / inbox context |
| `subagentStop` / `SubagentStop` | Close optional Implementation Task digressions (`[NAM_DISPATCH:…]`) |

VS Code Copilot Chat does not set `NAM_CONVERSATION_ID` as an environment variable (Cursor does). Use the conversation / session id from the SessionStart context, or pass `--conversation` to `nam-cli`.

## VS Code

**GitHub Copilot Chat (closest to Cursor):** install the recommended Copilot extensions, open Agent chat, and run `/nam-manager` or `/nam-impl`. Prompt files live in `.github/prompts/`; they load the canonical prompts from `.cursor/commands/`. Hooks are Preview — if they do not fire, run `Chat: Open Customizations` and confirm the NAM hooks are loaded (`Developer: Show Agent Debug Logs`).

**Continue:** install the Continue extension, open Agent mode (Ctrl+L), and type `/nam-manager` or `/nam-impl`. Prompt files live in `.continue/prompts/` and load the canonical prompts from `.cursor/commands/`. Continue does not run NAM lifecycle hooks. Pass `--conversation` to `nam-cli` (Continue does not set `NAM_CONVERSATION_ID`).

**Gemini CLI:** project commands live in `.gemini/commands/`. In Gemini chat, run `/nam-manager`, `/nam-impl`, and the handover commands. Gemini does not run the NAM lifecycle hooks.

The CLI, mailboxes, Memory Logs, and Implementation Plan are identical in every host.

## Guides

| Guide | Topic |
|-------|--------|
| [Automation_Guide.md](Guides/Automation_Guide.md) | Queue, CLI, hooks, digressions |
| [Task_Assignment_Guide.md](Guides/Task_Assignment_Guide.md) | TAPs and evaluation |
| [Memory_Log_Guide.md](Guides/Memory_Log_Guide.md) | Logging completed work |
| [Memory_System_Guide.md](Guides/Memory_System_Guide.md) | Memory tree ownership |
| [Project_Breakdown_Guide.md](Guides/Project_Breakdown_Guide.md) | Setup → plan decomposition |
| [Context_Synthesis_Guide.md](Guides/Context_Synthesis_Guide.md) | Discovery before breakdown |

## Install into a project

This repo is the NAM source. Copy NAM into a project with:

```bash
node .nam/Scripts/install.mjs --dest <project root> --dry-run   # preview
node .nam/Scripts/install.mjs --dest <project root>
```

It copies the guides, commands, hooks and every host's prompt wrappers, merges NAM's hook entries into existing hook configs, and backs up each overwritten file to `<project>/.nam/tmp/backup-<date>/`. Project state (Mailbox, Memory, Runtime, Implementation Plan) is never touched, and neither is `.nam/Local/`, where a project keeps its own prompt add-ons (`.nam/Local/nam-manager.md` and so on). Then follow the base setup in `.nam/Guides/Automation_Guide.md` §10.

## Requirements

- **Cursor**, or **VS Code** with GitHub Copilot Chat, Continue, or Gemini CLI
- Node.js (for `nam-cli` and hook scripts)
- [base](https://docs.basemode.ai/install) CLI on PATH for the code map, handoffs and forks. NAM still works without it but warns; check with `node .cursor/hooks/nam-cli.mjs doctor`.

## License

Use and adapt under the same terms as the host repository unless otherwise noted.
