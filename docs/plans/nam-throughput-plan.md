---
title: NAM throughput plan
type: plan
status: draft
created: 2026-11-19
tags: [nam, throughput, token-usage, base, ponytail, orchestration]
relatedTo: [ninja-agent-manager]
---

# NAM throughput plan

NAM spends its usage re-reading large contexts. The plan has two steps. First, cap context inside today's NAM: two days of work, and about 40% less usage per task if the targets hold. Then replace the LLM Manager with a small script that starts one fresh `claude -p` per task in a git worktree, checks the result with the project's own gate, and switches to Cursor when Claude limits are hit. The target for that loop is 2.5 times the tasks per unit of usage. Most NAM prompts, guides, hosts and the handover machinery are deleted.

**Sources of the numbers**

- **Given:** the docs facts and the token audit (2026-11-05 to 11-19) supplied with the request.
- **Measured:** read-only passes over the same transcripts and `.nam/` state, run for this plan with `decompose.mjs`, `manager.mjs`, `bash.mjs` and `counts.mjs` in `C:/Users/jbwhe/AppData/Local/Temp/claude/06b6c4221344e1d1/d572f620-2a4a-4ebb-b910-b035537faeb7/scratchpad/plan/`. That folder can be cleared; Phase 0 merged them into `.nam/Scripts/token-audit.mjs`, which reproduces the section 1 table.
- **Target:** a hypothesis the sandbox must confirm.

**Units.** *Token-reads* are the context size summed over every API call. 98% of input tokens are cache reads (given), so usage tracks token-reads. A *share of context* below is a share of the content a run adds, weighted by how many later calls re-read it.

## 1. Diagnosis

| | scouts | genai | Director's Vision |
|---|---|---|---|
| Tasks finished in the window (measured, `queue.json`) | 104 | 41 | 83 |
| Implementer calls per task (given) | ~161 | ~89 | ~49 |
| Implementer run: median calls, context at call 1, compactions (measured) | 94, 50k, 0 | 57, 44k, 0 | 48, 37k, 0 |
| Manager session: calls, average context (measured) | 132, 237k | 483, 305k | 170, 289k |
| Plan, `Memory_Root.md`, inbox file | 401 KB, 62 KB, 159 KB | 144 KB, 66 KB, 33 KB | 2.2 MB, 113 KB, 150 KB |

Implementer subagents take ~79% of usage, Manager sessions ~17%, interactive `/nam-impl` chats ~2%. Average context per call is ~280k for implementers and 240-305k for Managers (all given).

Causes, ranked by expected impact:

1. **Implementer runs never shed context (most of the 79%).** None of 323 measured runs compacted. A run makes about 50 to 120 calls, and everything read early is re-read on every later call. Nothing sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: the installed `.claude/settings.json` holds hooks only. `nam-impl.md:182` keeps research, implementation and three debug attempts (`:202-208`) in one chat.
2. **That context is mostly code exploration through the shell.** Shell output is 37-45% of context (160-236 KB per run). Of those bytes, 50-53% are file reads with `cat`/`sed`/`head`/`tail` and 16-22% are `grep`/`find`: 13-30 reads and 10-25 searches per run. The agent's own edit payloads are 10-20% and the Read tool 12-21%. The lever is a brief that names the entry points, and smaller tasks.
3. **The starting context is 37-61k tokens, re-read on every call: 14-34% of implementer token-reads.** It holds the project `CLAUDE.md` (scouts: 62 KB), the skill listing (27-29 KB in every subagent), tool and connector listings (16-23 KB), and NAM's reading list: `nam-impl.md` is 24 KB and its line 312 adds two guides (25 KB).
4. **Manager chats live too long (the 17%).** Their context is 21-27% NAM state read back in, 13-21% TAPs and plan edits written out, 10-28% startup listings and 2-10% review diffs. The instructions behind it:
   - `nam-manager.md:45` and `:107` read the whole plan; `:30` reads `Memory_Root.md`; `:47-50` reads four guides (43 KB).
   - `:142` reads the inbox file, which is never pruned: scouts has 319 entries, 1 unread. `inbox list` prints all of it (`nam-cli.mjs:323`); `queue list` prints every item ever queued (`nam-cli.mjs:238`, `nam-lib.mjs:217`).
   - `:167` appends to the plan's `Last Modification` line forever: 49 KB in Director's Vision, 35 KB in scouts.
   - `:148` runs the code review in the Manager's own context.
5. **Handovers.** Director's Vision is on Manager 119 (121 handover files), scouts on Manager 24. Each is a synthesis plus a full re-read (`nam-manager.md:107-113`).
6. **One model family carries everything.** `.claude/agents/nam-implementer.md:4` defaults to `opus`. scouts moved to Sonnet on 2026-11-19 through its Local add-on.

Not the problem:

- **Output size.** Subagent reports are 1-2% of Manager context.
- **Test output** is 2-5% of shell output, so the documented hook that trims it is skipped.
- **The whole-plan read** is 1.5-10% of Manager context: agents already grep the larger plans.

**base and ponytail so far.** NAM gained base on 2026-11-16 and ponytail on 11-17 (commits `7a351c5`, `17b8fb1`), so the sample is three days of runs.

- `base ast query` was called in 23%, 17% and 48% of implementer runs (scouts, genai, Director's Vision).
- PreToolUse hook context, almost all from base, is 13-60 KB per run: 3-10% of context.
- `nam-search-hint.mjs` covers the built-in Grep and Glob tools; a run uses Grep 0.5-1.9 times and Glob less.
- Against the whole window, average context did not drop in genai (272k to 326k) or Director's Vision (175k to 187k). scouts dropped (255k to 176k) but also changed model.

Neither has shown a throughput effect yet; both are tested in the replay (section 4).

## 2. Target design

**Principle.** Code runs the loop; an LLM only plans, implements or reviews. Every LLM run starts fresh, gets one small brief, and ends. The owner plans with the planner, merges, and answers blocked tasks.

### Roles

| Role | Runs as | Model | Context target | Stop |
|---|---|---|---|---|
| Planner | interactive `/nam-plan` | `opus` | average under 80k | one sitting per chat; no handover |
| Runner | `node .cursor/hooks/nam-cli.mjs run` | none | 0 | |
| Implementer | one `claude -p` per task, in a worktree | `sonnet`; `opus` for hard tasks | start under 25k, average under 100k | auto-compact near 150k, `--max-turns 120`, 45 minutes |
| Reviewer | one `claude -p`, read-only | the family the implementer did not use | average under 50k | `--max-turns 15` |

The Manager, the Setup agent and the per-domain `Agent_*` identities go.

**Why a Node script and not the Workflow tool.** Workflow scripts have no file or process access (Workflow authoring reference: no filesystem or Node API), so they cannot run a gate, create a worktree, write a ledger or call Cursor without spending LLM calls. The script drives `claude -p`, not the Agent SDK (given: SDK use on a subscription login is undocumented).

### The loop

`nam-cli run` does this for every open task whose `needs` are done, up to the project's `parallel` (4 today):

1. **Worktree.** `git worktree add -b <branch> .claude/worktrees/<slug> <base>`. The base is the default branch, or the branch of an unmerged task it depends on.
2. **Implement.** `claude -p --model <route> --output-format json --json-schema <result>`, plus the flags that open questions 2 and 4 settle. The prompt goes on stdin: the implementer contract, `.nam/Local/nam-impl.md`, the brief, and the result summary of each task it needs. The runner sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `BASH_MAX_OUTPUT_LENGTH` in the child's environment.
3. **Gate.** The runner runs the project's gate command in the worktree (scouts: `pnpm gate:fast --since origin/main` and `pnpm typecheck`; genai: `pnpm check:fast`). No LLM.
4. **Fix.** On a failed gate the last 100 lines go back once with `--resume`. A second failure starts a fresh run on the other model family. A third marks the task `blocked` and notifies the owner through `nam-notify.mjs`.
5. **Review.** Unless the task says `review: false`, the reviewer gets the brief and `git diff <base>` and returns a verdict and a must-fix list. Must-fix items get one fix round.
6. **Ship,** per `.nam/Local/runner.json`: `none` (leave the worktree for the owner; the default), `commit` (Director's Vision today) or `pr` (genai and scouts: push, `gh pr create`, stop). In `pr` mode the runner watches the checks with `gh` and feeds a failed job's log tail to step 4.
7. **Record.** The runner appends a `## Result` block to the task file, moves it to `.nam/Tasks/done/`, and adds a line to `.nam/Runtime/ledger.jsonl` (model, turns, usage, gate result, duration).

Nothing NAM installs is tracked in a project: `install.mjs:143` gitignores `.nam/`, `.claude/settings.json`, `.cursor/rules/ponytail.mdc` and `.base-ast/`. A worktree contains none of it, so the runner passes everything explicitly.

### Task file

One file per task replaces the plan entry, the TAP and the Memory Log. Limit: about 1.5 KB (TAPs average 4.4-8.5 KB today).

```markdown
---
title: Add session expiry   # branch and PR title; never a NAM ID
status: todo                # todo | running | gated | done | blocked
needs: []                   # tasks that must be done first
model: sonnet               # or opus; fable only with the owner's OK
review: true                # false for docs, config, tests-only
serial: false               # true: shared database, e2e stack or migration
---
Objective: one sentence.
Entry points: `SessionStore.open` in `src/auth/session.js`
Done when: checks the gate runs, plus any check only the owner can do.
Out of scope: ...
```

- **The plan is the set of open task files** plus a short `Roadmap.md`. `nam-cli status` prints it. Finished work leaves the plan, so it cannot grow.
- **The implementer contract** is under 1.5 KB: do the brief; base first, then the shell; ponytail; test your own code only; no NAM IDs in product code; no subagents.
- **The final message is JSON:** `status`, `summary`, `files`, `checks_run`, `not_checked`, `shortcuts`, `needs_owner`, `findings`. The runner writes the result from it. A non-empty `needs_owner` or `findings` stops dependent tasks and notifies the owner.

### Model routing and limits

| Task | Implementer | Reviewer |
|---|---|---|
| Docs, config, wiring, tests only | `sonnet` | none; gate only |
| Feature (default) | `sonnet` | `opus` |
| Hard (sync, auth, billing, migrations, cross-cutting), or failed twice | `opus` | `sonnet` |
| Hardest | `fable`, owner approves each use (may bill to usage credits, given) | `opus` |

This is the routing of the genai and scouts add-ons, applied by code. The reviewer uses the other family, so the two roles draw on different family limits. When one family reports its limit, implementers move to the other and reviews wait in `gated`. When both do, the runner uses Cursor. When Cursor is out too, it stops and notifies.

### Isolation

One worktree per task: a failed task is removed with its worktree, and the owner's checkout stays free. This reverses "worktrees are a last resort" in the genai and scouts add-ons (`.nam/Local/nam-manager.md:19`); that rule's concerns become the `serial` flag, and one `serial` task runs at a time.

### base and ponytail

Both stay warn-only.

- **base, keep:** the planner uses `base ast query` to write Entry points, which attacks cause 2. Decisions and rules go to the base graph and replace `Last Modification` and `Memory_Root.md`.
- **base, drop:** forks per queued TAP, handoffs, `reconcile`, and `nam-search-hint.mjs`.
- **ponytail, keep:** the plugin ruleset for implementers, `shortcut:` comments, and `/ponytail-debt` at planning time.
- **ponytail, narrow:** the review moves from the Manager to the reviewer run and is skipped for docs, config and tests-only tasks. NAM's copies of the ponytail contract become one line.

### Cursor as fallback

Step 2 swaps the command for `agent -p "<contract and brief>" --output-format text` in the same worktree (`agent.cmd` is installed at `C:/Users/jbwhe/AppData/Local/cursor-agent/`). Gates and shipping are code and do not change. The runner prepends `.cursor/rules/ponytail.mdc`, which a worktree lacks. Cursor implements only; reviews wait for Claude.

### What goes

| Today | Becomes | Why |
|---|---|---|
| `nam-manager.md`, both handover prompts, the `handover` command | `nam-cli run`, `/nam-plan` | 17% of usage; no step of the loop needs judgement, and no chat lives long enough to hand over |
| `nam-impl.md` (24 KB) | the contract, in `.claude/agents/nam-implementer.md` | lines 48-177 and 326-345 (step confirmation, agent names, handover) never apply to a fresh unattended run |
| `nam-setup.md` and all seven guides (98 KB) | `nam-plan.md` with the task template; a README section | setup is the first planning sitting; one file per task |
| `Implementation_Plan.md`, `Memory_Root.md` | open task files, `Roadmap.md` | frozen as archive; the plan holds open work only |
| Mailboxes, roles, inbox, dispatch, `nam-subagent-stop.mjs` | `.nam/Tasks/`, `ledger.jsonl` | every run is fresh, so agent identities mean nothing |
| `.github/`, `.continue/`, `.gemini/` wrappers and hooks | deleted | the budget is Claude and Cursor |

Two rules change: the ban on unattended execution (`nam-manager.md:141`, already overridden in two projects) and worktrees as a last resort. The owner's other rules stay.

## 3. Phased migration

Measures for every phase, from the audit script:

- average context per call, and context at call 1;
- calls and token-reads per finished task;
- tasks finished per day (baseline 16 across the three projects) and, once the ledger records limit hits, per 5-hour window;
- first-pass gate rate (not recorded today);
- rework: queue items per task (baseline scouts 1.03, genai 1.66, Director's Vision 1.12).

**Phase 0: measuring stick (half a day).** Merge `nam-token-audit.mjs` and the four scratchpad scripts into `.nam/Scripts/token-audit.mjs`, with one row per run. Answer open questions 1-5. Accept when it reproduces the table in section 1.

*Done 2026-11-19:* `node .nam/Scripts/token-audit.mjs --since 2026-11-05 [--until …] [--runs] <project root>...` reproduces the tasks, implementer, Manager and file-size rows (run it with `--self-test` to check the parser). Answers to questions 1-5 are in section 5.

**Phase 1: quick wins in current NAM (two days, NAM 1.3.0).**

| Change | Files | Expected effect |
|---|---|---|
| Compact near 150k (15 on a 1M window; open question 1); cap shell output at 8,000 characters | `.claude/settings.json` gains `env` (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `BASH_MAX_OUTPUT_LENGTH`); `install.mjs:126` merges `env` | Context roughly halves; the cap alone removes 13-21% of shell bytes |
| Self-contained implementer, Sonnet by default | `.claude/agents/nam-implementer.md`; drop `Task_Assignment_Guide.md:84-91` | No `nam-impl.md` or guide reads (8-17 KB per run); volume moves off the Opus limit |
| Smaller starting context | Owner: trim scouts `CLAUDE.md`; remove the repeated `Registered Workspaces` blocks in `~/.claude/CLAUDE.md`; disable unused skills and connectors | Context at call 1 under 35k |
| Manager reads less | `nam-manager.md:30`, `:45`, `:47-50`, `:107-111`, `:167`; `nam-cli.mjs:238` and `:323` print open items only | Up to a fifth of Manager context |
| Review outside the Manager | New `.claude/agents/nam-reviewer.md`; `nam-manager.md:148` | Diffs leave the Manager's context |

Accept after five working days: implementer average context under 130k; Manager average context under 150k; calls per task up by no more than 15%; rework no worse. If both context targets hold, token-reads per task fall by about 40% (target).

**Phase 2: sandbox prototype (three days).** `nam-cli run --task <file> --repo <dir>` for one task (steps 2-5 and 7), about 300 lines, with one self-test that uses a stub executor. See section 4.

**Phase 3: scouts on the new loop (one week).** Add the full loop, `nam-cli status`, `nam-plan.md` and `.nam/Local/runner.json`, and put `.claude/worktrees/` in the installer's gitignore block. Convert open queue items to task files; freeze the plan and `.nam/Memory/`. genai and Director's Vision stay on 1.3.0. Accept when token-reads per task are at most 40% of baseline; tasks per day are at least 7.4 (scouts baseline); the first-pass gate rate is at least 70%; and the owner steps in at most once per five tasks.

**Phase 4: roll out and delete (NAM 2.0).** genai, then Director's Vision. Remove the rows of "What goes" from the repo and from `COPY` in `install.mjs:28-44`; the installer already lists stale files per project. Accept when no Manager session appears in a week's audit.

## 4. Sandbox prototype

1. **Pick five finished tasks** with a subagent transcript, a known commit or PR, and a gate that needs no database, emulator or device: two from scouts (near 50 and near 150 calls), one from genai, one web or functions task from Director's Vision, and one that needed a review-fix round.
2. **Copy the code as it was before the task.** `git archive <base-sha>` into `.sandbox/replay/<name>/`, then `git init` and one commit. The consumer repo is not written, and the real solution is not in the copy's history.
3. **Write the brief by hand** from the TAP, in the task-file format. Run one task a second time with the original TAP text, to separate the loop's effect from the brief's.
4. **Run each task** through `nam-cli run` with the routing of section 2. Run one task three ways: as designed, with base's hooks off, and with ponytail off. Run one task through Cursor.
5. **Compare** with that task's own baseline row from `token-audit.mjs`: calls, average context, token-reads, minutes.
6. **Judge correctness:** the project gate passes, and the owner reads each diff next to the shipped one (accept, nits, reject).

- **Go:** at least four of five accepted, and median token-reads at most 50% of baseline.
- **No-go:** fewer than three accepted, or token-reads above 70%. Then keep Phase 1 and stop.

## 5. Risks and open questions

| # | Open question | Test | Answer |
|---|---|---|---|
| 1 | Do `sonnet` and `opus` resolve to a 200k or a 1M window? Peaks of 840k-966k say 1M. This sets the compaction percentage. | `claude -p "reply ok" --output-format json`; read the reported window | **1M for both** (probe 2026-11-19). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=15` compacts near 150k. |
| 2 | How small can the starting context get? | The same call with and without `--disable-slash-commands --strict-mcp-config --tools`; check that the ponytail ruleset still arrives | Default `-p` starts near 57k; with all three flags near 14k. Alone: `--strict-mcp-config` 51k, `--disable-slash-commands` 55k, `--tools` 61k (no cut). A subagent with a `tools:` allowlist starts at 11.1k instead of 44.9k. ponytail arrives in every case. |
| 3 | `--max-turns` is not in `claude --help` on 2.1.327. Does it work, and what does the result say when it trips? | One run with `--max-turns 2` | **Works.** Exit code 1, result subtype `error_max_turns`. |
| 4 | Does `--permission-mode auto` let a `-p` run use pnpm and git without prompts? Does `/ponytail-review` run in `-p` with `--json-schema`? | One replay. Failing that, the reviewer prompt carries the four criteria of `nam-manager.md:148` | Partly: `auto` ran node shell commands with no prompt or denial. pnpm, git and `/ponytail-review` in `-p` wait for the Phase 2 replay; `nam-reviewer` already carries the four criteria. |
| 5 | Does `base ast query` find a map from a worktree or a copy? Can base's hook hints be switched off for one process? | Run it in `.sandbox/replay/`; ask base's author | **No map in a worktree** ("No code map covers…"); `--target <main checkout>` works, and the implementer prompt says so. No per-process switch for base's hooks found (they run as `base hook <event>`); ask base's author. |
| 6 | What does `claude -p` print and exit with at a limit? Does `--fallback-model` cross families? Does Sonnet have its own limit? | Cannot be forced. The runner logs every failed run; until a limit is seen, any failure stops the loop and notifies | Open |
| 7 | Cursor `agent -p`: login in a clean shell, exit codes, cost per task on the legacy plan | One replay through Cursor | Open |
| 8 | Do Android builds work in a worktree? | One Director's Vision task; if not, that project runs one task at a time in the main checkout | Open |

Risks:

- **Subscription terms.** `claude -p` and `claude setup-token` are documented for scripts on a subscription; the SDK is not. The runner uses only the CLI, runs only when the owner starts it, and keeps to four parallel runs.
- **Limit sizes are unknown.** The ledger measures them: token-reads between two limit hits.
- **Quality with smaller contexts and Sonnet.** Watch the gate rate and rework; each knob is one line to revert.
- **Usage credits.** Fable is never routed automatically; check that the admin spend limit is zero or small.
- **The owner becomes the bottleneck.** Finished worktrees and PRs wait for a merge, and dependent tasks wait with them.
- **Windows.** Set `git config core.longpaths true` for worktrees with `node_modules`.

Stop or roll back when:

- Anthropic warns about automated use, or `-p` stops working on the subscription. Stop the runner and return to NAM 1.3.0, which is interactive.
- Phase 1: rework rises above one fix round per five tasks. Revert the `env` values or the model default.
- Phase 2: the no-go result in section 4.
- Phase 3: after a week scouts finishes fewer tasks per day than baseline, or the owner spends more time unblocking. Reinstall 1.3.0 with `install.mjs`; mailboxes and Memory are untouched until Phase 4.
