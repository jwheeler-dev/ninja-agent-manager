# Ninja Agent Manager (NAM)

**NAM** is a Cursor-native system for running multi-agent software projects with a clear human-in-the-loop workflow: a Manager plans and enqueues work; you open Implementation chats that claim and execute tasks; Memory Logs stay the source of truth.

It is built around a disk-backed task queue, slash-command agents, and Cursor hooks that reduce copy-paste and nudge handovers when context pressure rises.

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
  Runtime/          # Roles, inbox, snapshots, dispatch state
  Scripts/          # Export and maintenance helpers
  Implementation_Plan.md
  metadata.json
  README.md

.cursor/
  commands/         # nam-*.md slash commands
  hooks/            # nam-cli, nam-lib, session/stop/compact hooks
  hooks.json
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
```

## Hooks

Configured in `.cursor/hooks.json`:

| Hook | Purpose |
|------|---------|
| `sessionStart` | Bind `NAM_CONVERSATION_ID`; inject queue / handover / inbox context |
| `preCompact` | Mark pending handover under context pressure |
| `stop` | Nudge full handover when eligible, else soft snapshot |
| `subagentStop` | Close optional Implementation Task digressions (`[NAM_DISPATCH:…]`) |

## Guides

| Guide | Topic |
|-------|--------|
| [Automation_Guide.md](Guides/Automation_Guide.md) | Queue, CLI, hooks, digressions |
| [Task_Assignment_Guide.md](Guides/Task_Assignment_Guide.md) | TAPs and evaluation |
| [Memory_Log_Guide.md](Guides/Memory_Log_Guide.md) | Logging completed work |
| [Memory_System_Guide.md](Guides/Memory_System_Guide.md) | Memory tree ownership |
| [Project_Breakdown_Guide.md](Guides/Project_Breakdown_Guide.md) | Setup → plan decomposition |
| [Context_Synthesis_Guide.md](Guides/Context_Synthesis_Guide.md) | Discovery before breakdown |

## Requirements

- [Cursor](https://cursor.com) with project slash commands and hooks enabled
- Node.js (for `nam-cli` and hook scripts)

## License

Use and adapt under the same terms as the host repository unless otherwise noted.
