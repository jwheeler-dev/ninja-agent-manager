# NAM 1.0 (Ninja Agent Manager) - Automation Guide

Disk-backed dispatch and context-pressure handover for NAM 1.0 (Ninja Agent Manager) in Cursor.

Hooks live in `.cursor/hooks.json` and inject/nudge via `sessionStart`, `preCompact`, `stop`, and `subagentStop`.

---

## 1. Goals

- **Manager enqueues; User opens Implementation chats; `/nam-impl` executes.**
- Manager **must not** auto-run plan tasks (no Task-tool execution of Implementation Plan work).
- Reduce copy-paste: queue on disk + path-only completion inbox.
- Auto-nudge handover / soft-snapshot under context pressure.
- Keep `.nam/Memory` as the source of truth for completed work.
- Prefer `nam-cli` for disk mutations (roles, queue, inbox, snapshots).

---

## 2. Role registration (conversation-scoped)

`sessionStart` sets env `NAM_CONVERSATION_ID`. Roles are stored per conversation in `.nam/Runtime/roles.json` (mirrored to `active_role.json` for convenience).

**Preferred (CLI):**

```bash
node .cursor/hooks/nam-cli.mjs role set --role manager --eligible false
node .cursor/hooks/nam-cli.mjs role set --role implementation --agent Agent_Android --eligible false --notes "waiting on Memory Log"
node .cursor/hooks/nam-cli.mjs role set --role manager --eligible true
node .cursor/hooks/nam-cli.mjs role get
node .cursor/hooks/nam-cli.mjs role clear
```

| Field | Values |
|-------|--------|
| `role` | `manager` or `implementation` |
| `handover_eligible` | `true` only when a full cycle is done and handover is allowed; otherwise `false` |
| `agent_name` | Manager, or registered Implementation name |

Full handover auto-nudge runs only when `handover_eligible === true` for **this** conversation. If pressure hits while ineligible, a **soft snapshot** is written instead (§7).

---

## 2b. NAM CLI overview

```bash
node .cursor/hooks/nam-cli.mjs status
node .cursor/hooks/nam-cli.mjs assign --agent Agent_X --task-ref "Task X.Y - Title" --log <memory_log_path> --file tap.md
node .cursor/hooks/nam-cli.mjs queue list --agent Agent_X
node .cursor/hooks/nam-cli.mjs claim --agent Agent_X
node .cursor/hooks/nam-cli.mjs complete --agent Agent_X --log <path> [--notes TEXT]
node .cursor/hooks/nam-cli.mjs snapshot write --notes "..."
node .cursor/hooks/nam-cli.mjs inbox list
node .cursor/hooks/nam-cli.mjs inbox ack --all
```

Use CLI instead of hand-editing JSON whenever possible.

---

## 3. Task queue (Manager → Implementation)

**Model:** Manager only **enqueues** Task Assignment Prompts. The User opens (or reuses) an Implementation Agent chat and runs `/nam-impl`. That agent **claims the next queued task** and executes it. Manager later **reviews** via inbox / Memory Log paths - same review rules as before.

**Manager is prohibited from** spawning Cursor Task subagents to execute plan tasks.

### Enqueue (Manager)

```bash
node .cursor/hooks/nam-cli.mjs assign --agent Agent_Domain --task-ref "Task X.Y - Title" --log <memory_log_path> --file tap.md
```

This appends to `.nam/Mailbox/<Agent>/queue.json` and writes `.nam/Mailbox/<Agent>/tasks/<id>.md`. Multiple tasks may be queued; FIFO.

Then tell the User: open/reuse that agent’s chat → `/nam-impl` (no paste of the full TAP).

### Layout

```
.nam/Mailbox/Agent_<Domain>/
  queue.json          # ordered items with status pending|claimed|completed
  tasks/001.md        # TAP bodies
  pending.md          # convenience copy of next pending TAP (optional)
  claimed.md          # convenience copy of current claimed TAP
  meta.json           # convenience pointer to current head
```

### Claim + execute (Implementation /nam-impl)

On init (or when idle with queue work):

```bash
node .cursor/hooks/nam-cli.mjs claim --agent <YourAgent>
```

Then execute the TAP at the returned `tap_path` / `claimed.md`. Do not wait for paste when a queue item exists.

After Memory Log is written:

```bash
node .cursor/hooks/nam-cli.mjs complete --agent <YourAgent> --log <memory_log_path> [--notes "..."]
```

If more items are pending, tell the User the next queue depth; claim the next item only after User confirmation unless they asked to drain the queue.

### Manager review

Same as before:

1. Read `.nam/Runtime/manager_inbox.json` (`acked: false`) or User notice with log path.
2. Review Memory Log (and artifacts if flags true).
3. `inbox ack --task-ref "..."` or `--all`.
4. Enqueue next task(s) when ready.

Paste of full prompts remains a last-resort fallback only.

---

## 4. Completion report (User summary + Manager path)

`complete` appends to `.nam/Runtime/manager_inbox.json`.

**To the User:** present the mandatory **Completion Summary** from `.cursor/commands/nam-impl.md` (problem/goal, what changed, files touched, verification, risks/residuals, flags, Memory Log path). Do not collapse this to a short blurb.

**To the Manager:** path-only is enough - review the Memory Log at `memory_log_path` (and artifacts when flags are true). No User-POV paste block required.

---

## 5. Manager handover (disk pointer)

When running `/nam-handover-manager`:

1. Create the Handover File under `.nam/Memory/Handovers/Manager_Agent_Handovers/` as usual.
2. Also write `.nam/Runtime/active_manager_handover.md` containing the full Handover Prompt body.
3. `node .cursor/hooks/nam-cli.mjs role clear` after artifacts are written.
4. Tell the User: open a **new** chat → `/nam-manager`. Paste is optional if the pointer file exists.
5. Delete `.nam/Runtime/pending_handover.json` after successful artifact write.

Incoming Manager (`/nam-manager`): if Memory Root has real project content **and** `.nam/Runtime/active_manager_handover.md` exists, load that file and **do not ask the User to paste**.

After successful resume, delete or empty `active_manager_handover.md`.

---

## 6. Implementation handover (disk pointer)

Same pattern with `/nam-handover-impl` → `.nam/Runtime/active_implementation_handover.md` → new chat `/nam-impl`.

---

## 7. Context-pressure automation

| Hook | Behavior |
|------|----------|
| `sessionStart` | Sets `NAM_CONVERSATION_ID`; injects queue / handover / soft-snapshot / inbox |
| `preCompact` | Writes `.nam/Runtime/pending_handover.json` |
| `stop` (eligible) | Followup to run `/nam-handover-manager` or `/nam-handover-impl` for this conversation |
| `stop` (ineligible) | Soft snapshot + enrich via CLI |
| `subagentStop` | Closes optional Impl Task digressions (`[NAM_DISPATCH:…]`) |

### Soft snapshots

When context pressure hits mid-cycle (`handover_eligible` is not `true`):

1. Hook writes `.nam/Runtime/soft_snapshots/<conversation>.md` and `soft_snapshot_latest.json`.
2. Agent enriches: `node .cursor/hooks/nam-cli.mjs snapshot write --notes "..."`.
3. When the cycle completes, set `--eligible true` and run full handover.

---

## 8. Manager inbox review

1. Read `.nam/Runtime/manager_inbox.json`.
2. For each `acked: false` entry, read `memory_log_path` and review per Memory Log Guide.
3. Ack via CLI.
4. Continue the Task Loop - **enqueue** next work (do not auto-execute).

---

## 9. Optional Task digressions (Implementation only)

`/nam-impl` owns research, debug, and implementation in one chat. There are **no** `/nam-adhoc`, `/nam-research`, or `/nam-debug` commands.

Cursor **Task** subagents are optional digressions when isolation helps — never for draining the plan queue, never from Manager for plan tasks.

| Work | How |
|------|-----|
| Plan tasks | Queue + `/nam-impl` chat (research/debug in-chat) |
| Noisy research digression | Optional Task (`explore` / `generalPurpose`) from Impl |
| Noisy debug digression | Optional Task (`generalPurpose`) from Impl; escalate to Manager after 3 failed in-chat attempts |

```bash
node .cursor/hooks/nam-cli.mjs dispatch register --id digression_1 --kind digression_research --parent implementation
```

Put `[NAM_DISPATCH:<id>]` in the Task description. `subagentStop` writes `.nam/Runtime/task_results/<id>.md` and followups the parent Implementation Agent. Set Memory Log `ad_hoc_delegation: true` when a digression was used.

---

**End of Guide**
