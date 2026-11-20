# NAM 1.0 (Ninja Agent Manager) - Automation Guide

Disk-backed dispatch for NAM 1.0 (Ninja Agent Manager).

Hooks live in `.cursor/hooks/` and are wired by:

- **Cursor:** `.cursor/hooks.json` (`sessionStart`, `subagentStop`)
- **VS Code Copilot Chat:** `.github/hooks/nam.json` (`SessionStart`, `SubagentStop`)
- **Claude Code:** `.claude/settings.json` (`SessionStart`, plus `PreToolUse` on `Grep|Glob`)

Slash commands are defined once in `.cursor/commands/`. Cursor loads them directly; VS Code Copilot Chat loads wrappers in `.github/prompts/`; Continue loads wrappers in `.continue/prompts/`; Gemini CLI loads wrappers in `.gemini/commands/`; Claude Code loads wrappers in `.claude/commands/`. Claude Code runs the same `sessionStart` script through `.claude/settings.json`, which exports `NAM_CONVERSATION_ID` to its Bash and PowerShell tools. Pass `--conversation <id>` to `nam-cli` only when the env var is unset.

---

## 1. Goals

- **Manager enqueues; User opens Implementation chats; `/nam-impl` executes.**
- Manager **must not** auto-run plan tasks (no Task-tool execution of Implementation Plan work).
- Reduce copy-paste: queue on disk + path-only completion inbox.
- Keep `.nam/Memory` as the source of truth for completed work.
- Prefer `nam-cli` for disk mutations (roles, queue, inbox).

---

## 2. Role registration (conversation-scoped)

`sessionStart` (Cursor) sets env `NAM_CONVERSATION_ID`. VS Code Copilot Chat injects the same id as session context (`session_id`) but does not export the env var — pass `--conversation` to `nam-cli` when the env is unset. Roles are stored per conversation in `.nam/Runtime/roles.json` (mirrored to `active_role.json` for convenience).

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

`handover_eligible` is for `/nam-handover-*` when the User asks for a new chat. Hooks do not auto-nudge handover.

---

## 2b. NAM CLI overview

```bash
node .cursor/hooks/nam-cli.mjs status
node .cursor/hooks/nam-cli.mjs assign --agent Agent_X --task-ref "Task X.Y - Title" --log <memory_log_path> --file tap.md
node .cursor/hooks/nam-cli.mjs queue list --agent Agent_X [--all]   # open items; --all adds completed
node .cursor/hooks/nam-cli.mjs claim --agent Agent_X
node .cursor/hooks/nam-cli.mjs complete --agent Agent_X --log <path> [--notes TEXT]
node .cursor/hooks/nam-cli.mjs inbox list [--all]                   # unread entries; --all adds acked
node .cursor/hooks/nam-cli.mjs inbox ack --all
node .cursor/hooks/nam-cli.mjs doctor
node .cursor/hooks/nam-cli.mjs handover register --agent Manager|Agent_X --file <numbered handover file>
node .cursor/hooks/nam-cli.mjs handover accept --agent Manager|Agent_X
node .cursor/hooks/nam-cli.mjs reconcile [--apply]
```

See §10 for what each command does with base. Use CLI instead of hand-editing JSON whenever possible.

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

1. Run `inbox list` (it prints unread entries only), or take the log path from the User or a subagent's reply.
2. Review the Memory Log (and artifacts if flags are true), and have the code reviewed (§11).
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
3. `node .cursor/hooks/nam-cli.mjs handover register --agent Manager --file <numbered Handover File>` (registers a base handoff; never pass the pointer).
4. `node .cursor/hooks/nam-cli.mjs role clear` after artifacts are written.
5. Tell the User: open a **new** chat → `/nam-manager`. Paste is optional if the pointer file exists.

Incoming Manager (`/nam-manager`): if Memory Root has real project content **and** `.nam/Runtime/active_manager_handover.md` exists, load that file and **do not ask the User to paste**.

After successful resume, run `node .cursor/hooks/nam-cli.mjs handover accept --agent Manager`: it archives the base handoff and empties `active_manager_handover.md`.

---

## 6. Implementation handover (disk pointer)

Same pattern with `/nam-handover-impl` → `.nam/Runtime/active_implementation_handover.md` → new chat `/nam-impl`. The outgoing agent runs `handover register --agent <Agent>`; the incoming one runs `handover accept --agent <Agent>`.

**Queue beats stale handover:** If the agent's mailbox has pending (or claimed) work, `/nam-impl` must **claim and execute** — not run multi-step handover confirmation. `nam-cli assign` clears `active_implementation_handover.md` when it targets that agent so "queue empty" handover text cannot block the next TAP.

---

## 7. Hooks

| Hook | Behavior |
|------|----------|
| `sessionStart` / `SessionStart` | Sets conversation id (Cursor: env `NAM_CONVERSATION_ID`; Claude Code: `CLAUDE_ENV_FILE`; VS Code: session context); injects queue / handover / inbox, the base code-access block and the ponytail block (§11) |
| `subagentStop` / `SubagentStop` | Closes optional Impl Task digressions (`[NAM_DISPATCH:…]`). Cursor matches the Task description; VS Code may only surface a `systemMessage` unless the dispatch id is in the subagent payload. |

Claude Code runs `SessionStart` and `nam-search-hint.mjs` as a `PreToolUse` hook on `Grep|Glob` (see §10). It does not run `SubagentStop`: that payload carries no Task description, so `[NAM_DISPATCH:…]` could never match. Gemini CLI and Continue do not run these hooks. Use `/nam-handover-*` when the User wants a new chat.

---

## 8. Manager inbox review

1. Run `node .cursor/hooks/nam-cli.mjs inbox list` (unread entries only; `--all` adds acked ones).
2. For each entry, read `memory_log_path` and review per Memory Log Guide.
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

## 10. base integration

NAM uses the [base](https://docs.basemode.ai) CLI by default for code access, handoffs and forks. It is **warn-only**: no NAM command fails or waits on base. Problems come back as warnings in the `base` field of `nam-cli` output, each with the command that fixes it. `NAM_BASE=off` skips base entirely.

**Setup, once per repo:**

```bash
base scaffold .                                          # workspace (.base/)
base project add --name "<Project>" --path "<repo root>" # project whose path is the NAM root
base sync --ast --target .                               # code map (.base-ast/ast.ttl)
node .cursor/hooks/nam-cli.mjs doctor                    # every check should pass
node .cursor/hooks/nam-cli.mjs reconcile --apply         # forks for tasks already queued
```

**`doctor` checks** that base is on PATH, a workspace exists at or above the root, a base project's path is the root, and the code map exists, parses, is under 7 days old and is gitignored. `role set`, `assign`, `claim` and `status` run the same checks; a passing result is cached for an hour.

| NAM step | base effect |
|----------|-------------|
| `assign` | Registers the queued TAP as a fork (`nam-<agent>-<id>-task-<x-y>`). Archives the agent's handoff when `assign` cleared its stale pointer |
| `claim` | Registers a fork for an item queued before base was set up |
| `complete` | Nothing: the fork stays open until the Manager reviews |
| `inbox ack` | Archives the forks of the acked tasks |
| `handover register` | Registers the numbered Handover File as a handoff in lane `<Agent>` (`nam-<agent>-handover-<N>`). base archives that lane's earlier handoff |
| `handover accept` | Archives the lane's handoff and empties its pointer file |
| `reconcile [--apply]` | Dry run by default. Backfills missing forks; archives forks of acked or cancelled items, and handoffs whose pointer moved on |
| `sessionStart` | Adds the code-access block and any preflight warnings. Starts a background `base sync --ast` when the map is over a day old (Cursor has no base hook to refresh it) |
| Claude Code `Grep` / `Glob` | `nam-search-hint.mjs` adds a `base ast query` hint before the search runs. Advisory only; silent for docs and config, when no map exists, and when the map holds no code file under the searched folder or matching the glob's extension (dot-directories included, since base's map skips them). It caches the map's code-file list in `.nam/Runtime/base_map_files.json` and rebuilds it when the map changes. base's own hook covers shell grep, rg, find and PowerShell `Select-String`, but not these built-in tools |

**Code access:** agents run `base ast query` (`--file`, `--contains`, `--calls`, `--imports`) before grep or whole-file reads, then read only the lines they need. The map skips dot-directories, so NAM's own files are found with grep.

**Known issue:** base 0.16 escapes `\n` but not `\r` inside string literals, so a CRLF file with a multi-line entity name breaks the map (`Failed to parse Turtle`). Convert that file type to LF (`.gitattributes`: `*.ext text eol=lf`) and re-run `base sync --ast`.

**Deferral:** base's `[defer]` config parks handoffs and forks nobody has touched for a while; nothing is lost, and `base fork deferred` lists them. Suggested for NAM workspaces: `[defer] enabled = true` with `[defer.days] fork = 14` and `handoff = 7` in `.base/base.toml`. It applies to the whole workspace, so preview with `base reconcile --dry-run` first.

---

## 11. ponytail integration

[ponytail](https://github.com/DietrichGebert/ponytail) (MIT) is a coding-discipline ruleset. Before writing code the agent takes the first option that works: does it need to exist, already in the codebase, standard library or platform feature, an installed dependency, one line, else the minimum that works plus one small test for new logic. It never cuts validation, error handling, security or accessibility, ends each reply with what it skipped or did not check and the risks, and marks deliberate shortcuts with `shortcut: <limit>, <when to upgrade>` comments. Like base it is **warn-only**: when ponytail is missing NAM says so and keeps working. `NAM_PONYTAIL=off` skips the check.

**Install, per host:**

| Host | What ponytail adds | Install |
|------|--------------------|---------|
| Claude Code | Plugin: the ruleset in every session and subagent (including `nam-implementer`), plus `/ponytail [lite\|full\|ultra\|off]`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt` | Once per user: `/plugin marketplace add DietrichGebert/ponytail`, then `/plugin install ponytail@ponytail` |
| Cursor | The always-on rule `.cursor/rules/ponytail.mdc`; no commands | The NAM installer copies it into each project (pinned tag, vendored at `.nam/Vendor/ponytail/`) and gitignores it in the managed block |
| VS Code Copilot Chat, Continue | Nothing: not wired | Copilot Chat would need `.github/copilot-instructions.md`, a product file NAM does not write |
| Gemini CLI | Not wired by NAM | `gemini extensions install https://github.com/DietrichGebert/ponytail` |

**What NAM checks:** `doctor` reports a `ponytail` field and never changes its exit code for it: the Claude Code plugin is installed (`~/.claude/plugins/installed_plugins.json`) and enabled (`enabledPlugins` in user, project or local settings), the project has `.cursor/rules/ponytail.mdc`, and, for information only, whether `~/.cursor/hooks.json` has ponytail's Cursor hooks. `sessionStart` adds the warnings for the host it runs in, and one line restating the contract below where ponytail is active.

**Contract:**

- The TAP decides **what** to build; ponytail decides **how little code**. It never drops TAP deliverables, acceptance criteria, tests the TAP asks for, validation, security or accessibility.
- Implementation agents put ponytail's skipped / not checked / risks under the Memory Log's **Issues** and list each `shortcut:` comment they added under **Shortcuts** (`path:line`, limit, when to revisit). Shortcut comments carry no task or ticket IDs.
- Before `inbox ack`, the Manager has the `nam-reviewer` subagent review that task's changes (Claude Code, §13), or reviews them against the same criteria elsewhere: correct, safe, risky logic tested, no code the TAP did not need. Must-fix findings become a follow-up TAP or a fix note first.
- When planning a phase, the Manager may run `/ponytail-debt` (Claude Code) and fold shortcuts that are due into the plan.
- A TAP names a ponytail level (`lite`, `ultra`, `off`) only when the default `full` does not fit.

To move to a newer ponytail tag, follow `.nam/Vendor/ponytail/README.md`.

---

## 12. Project add-ons (`.nam/Local/`)

Project-specific rules live outside the shared prompts so a NAM upgrade never overwrites them. Each command prompt tells the agent to read `.nam/Local/<command>.md` (for example `.nam/Local/nam-manager.md`) when it exists and to follow it; it wins where it conflicts with the shared prompt.

Typical add-ons: notification rules (`nam-notify.mjs`), background execution with the `nam-implementer` subagent, and product-specific how-tos for Implementation agents. `install.mjs` never writes to `.nam/Local/`.

An add-on may point to the project's own files, such as a guide in `.nam/Guides/` or a script in `.nam/Scripts/`. The installer leaves a file alone when this source repo never shipped it, and reports a file as stale only when NAM shipped it once and has since dropped it.

---

## 13. Subagents and context budget (Claude Code)

Every model call re-reads the whole context, so NAM keeps contexts small. The installer merges these into `.claude/settings.json`; override them in `.claude/settings.local.json`:

| Setting | Value | Effect |
|---------|-------|--------|
| `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `15` | Compacts at about 150k tokens of the 1M window instead of near the end |
| `env.BASH_MAX_OUTPUT_LENGTH` | `8000` | Caps one shell output at 8,000 characters |

Two subagents ship in `.claude/agents/`:

- **`nam-implementer`** (Sonnet) runs one TAP unattended when `.nam/Local/nam-manager.md` allows background runs. Its prompt is self-contained: it does not read `nam-impl.md` or the guides, but it does read `.nam/Local/nam-impl.md`. A `tools:` allowlist keeps its starting context near 11k tokens instead of 45k. It finds code with `base ast query` (`--target <main checkout>` in a git worktree), writes the Memory Log, runs `complete`, and replies in at most 20 lines. The Manager may pass another model when spawning it.
- **`nam-reviewer`** (Opus, read-only) reviews one completed task before `inbox ack`, so diffs stay out of the Manager's context. The Manager gives it the task's goal, the Memory Log path and the changes to review, and passes `model: sonnet` when the task ran on Opus so each task gets the other family's eye. It replies `Verdict: ok | fix | block` with must-fix lines.

The Manager reads the plan's header and current phase rather than the whole file, reads only the guide sections it needs, and replaces the plan's `Last Modification:` line instead of appending to it.

---

**End of Guide**
