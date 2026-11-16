#!/usr/bin/env node
/**
 * NAM CLI — mailbox queue + digression helpers for Manager / Implementation agents.
 *
 * Usage:
 *   node .cursor/hooks/nam-cli.mjs <command> [options]
 *
 * Conversation id comes from --conversation or env NAM_CONVERSATION_ID
 * (set automatically by sessionStart hook).
 */
import fs from "node:fs";
import path from "node:path";
import {
  appendManagerInbox,
  claimNextAssignment,
  clearRole,
  completeAssignment,
  enqueueAssignment,
  getRole,
  listPendingMailboxes,
  loadDispatchStore,
  loadManagerInbox,
  mailboxPath,
  nowIso,
  readJson,
  resolveConversationId,
  runtimePath,
  saveDispatchStore,
  saveManagerInbox,
  setRole,
  summarizeAgentQueue,
  writeJson,
  ensureDir,
  clearHandoverPointer,
  projectRoot,
} from "./nam-lib.mjs";
import {
  archiveFork,
  archiveHandoff,
  archiveStaleHandoff,
  gateSummary,
  parseHandoverPath,
  preflight,
  reconcile,
  registerFork,
  registerHandoff,
  toProjectRel,
} from "./nam-base.mjs";

function usage(code = 1) {
  const text = `NAM CLI

Commands:
  status
  role set --role manager|implementation [--agent NAME] [--eligible true|false] [--notes TEXT] [--conversation ID]
  role get [--conversation ID]
  role clear [--conversation ID]

  assign --agent Agent_X --task-ref "Task X.Y - Title" --log <memory_log_path> (--file tap.md | --stdin)
  queue list --agent Agent_X
  claim --agent Agent_X [--id 001]
  complete --agent Agent_X --log <path> [--notes TEXT] [--important] [--compat] [--adhoc]

  dispatch register --id ID --kind digression_research|digression_debug
      [--task-ref TEXT] [--log PATH] [--agent NAME] [--parent implementation]
      (optional Task digression only — plan tasks use mailbox queue)
  dispatch list

  inbox list
  inbox ack --all | --task-ref TEXT

  doctor                         base preflight (exit 1 if a check fails)
  handover register --agent Manager|Agent_X --file <numbered handover file>
  handover accept --agent Manager|Agent_X
  reconcile [--apply]            sync base forks/handoffs with NAM state (dry run by default)

base is used by default and never blocks NAM: failures come back as warnings
in the "base" field. NAM_BASE=off skips base entirely.
`;
  process.stderr.write(text);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function flagBool(v, defaultValue = false) {
  if (v === undefined || v === null) return defaultValue;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return defaultValue;
}

function requireConversation(args) {
  const id = args.conversation || resolveConversationId({});
  if (!id) {
    throw new Error(
      "Missing conversation id. Pass --conversation or ensure NAM_CONVERSATION_ID is set (sessionStart hook).",
    );
  }
  return id;
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

/** Cached base preflight for gated commands. Warns, never blocks. */
function baseGate() {
  const pf = preflight();
  if (!pf.ok && !pf.disabled) {
    process.stderr.write(
      `nam-cli: base preflight has ${pf.warnings.length} warning(s); NAM continues. Details: node .cursor/hooks/nam-cli.mjs doctor\n`,
    );
  }
  return gateSummary(pf);
}

async function readTapBody(args) {
  if (args.file) {
    const p = path.isAbsolute(args.file)
      ? args.file
      : path.join(process.cwd(), args.file);
    return fs.readFileSync(p, "utf8");
  }
  if (args.stdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("assign requires --file <tap.md> or --stdin");
}

async function cmdStatus() {
  const roles = readJson(runtimePath("roles.json"), { conversations: {} });
  const pending = listPendingMailboxes();
  const inbox = loadManagerInbox();
  const unread = inbox.entries.filter((e) => !e.acked);
  const dispatch = loadDispatchStore();
  printJson({
    conversation_env: process.env.NAM_CONVERSATION_ID || null,
    roles: roles.conversations || {},
    pending_mailboxes: pending,
    unread_inbox: unread.length,
    active_dispatches: dispatch.active,
    base: gateSummary(preflight()),
  });
}

async function cmdRole(args) {
  const sub = args._[1];
  if (sub === "get") {
    const id = args.conversation || resolveConversationId({});
    printJson({ conversation_id: id, role: getRole(id) });
    return;
  }
  if (sub === "clear") {
    const id = requireConversation(args);
    clearRole(id);
    printJson({ cleared: id });
    return;
  }
  if (sub === "set") {
    const id = requireConversation(args);
    if (!args.role || !["manager", "implementation"].includes(args.role)) {
      throw new Error("--role must be manager or implementation");
    }
    const patch = {
      role: args.role,
      agent_name: args.agent || (args.role === "manager" ? "Manager" : null),
      handover_eligible: flagBool(args.eligible, false),
    };
    if (typeof args.notes === "string") patch.notes = args.notes;
    const saved = setRole(id, patch);
    printJson({ ...saved, base: baseGate() });
    return;
  }
  usage(1);
}

async function cmdAssign(args) {
  const agent = args.agent;
  if (!agent) throw new Error("--agent required");
  if (!args["task-ref"] && !args.task_ref) {
    throw new Error("--task-ref required");
  }
  if (!args.log) throw new Error("--log (memory_log_path) required");
  const taskRef = args["task-ref"] || args.task_ref;
  const body = await readTapBody(args);
  const item = enqueueAssignment({
    agent,
    taskRef,
    memoryLogPath: args.log,
    tapBody: body,
  });
  const summary = summarizeAgentQueue(agent);
  const gate = baseGate();
  const fork = registerFork(agent, item);
  const handoff = archiveStaleHandoff(agent);
  printJson({
    ok: true,
    enqueued: item,
    pending_count: summary.pending_count,
    cleared_impl_handover:
      "cleared if active_implementation_handover.md targeted this agent",
    user_hint: `Open/reuse ${agent} chat and run /nam-impl — it will claim the next queued task.`,
    base: { ...gate, fork, ...(handoff.noop ? {} : { handoff_archived: handoff }) },
  });
}

async function cmdQueue(args) {
  const sub = args._[1];
  if (sub !== "list") usage(1);
  const agent = args.agent;
  if (!agent) throw new Error("--agent required");
  printJson(summarizeAgentQueue(agent));
}

async function cmdClaim(args) {
  const agent = args.agent;
  if (!agent) throw new Error("--agent required");
  const result = claimNextAssignment(agent, { id: args.id || null });
  const gate = baseGate();
  // Items queued before base was set up get their fork on claim.
  const fork = result.item.base_fork ? null : registerFork(agent, result.item);
  printJson({
    ok: true,
    ...result,
    tap_path: `.nam/Mailbox/${agent}/${result.item.tap_path}`,
    base: { ...gate, ...(fork ? { fork } : {}) },
  });
}

async function cmdComplete(args) {
  const agent = args.agent;
  if (!agent) throw new Error("--agent required");
  if (!args.log) throw new Error("--log required");
  const result = completeAssignment(agent, {
    log: args.log,
    notes: typeof args.notes === "string" ? args.notes : undefined,
    important: flagBool(args.important, false),
    compat: flagBool(args.compat, false),
    adhoc: flagBool(args.adhoc, false),
  });
  printJson({
    ok: true,
    completed: result.item,
    next_pending: result.next_pending,
    inbox: "appended",
  });
}

async function cmdDispatch(args) {
  const sub = args._[1];
  if (sub === "list") {
    printJson(loadDispatchStore());
    return;
  }
  if (sub === "register") {
    if (!args.id) throw new Error("--id required");
    if (
      !args.kind ||
      ![
        "digression_research",
        "digression_debug",
        "adhoc_research",
        "adhoc_debug",
      ].includes(args.kind)
    ) {
      throw new Error(
        "--kind must be digression_research | digression_debug (aliases: adhoc_research | adhoc_debug). Plan tasks use the mailbox queue; Manager must not auto-run them.",
      );
    }
    const store = loadDispatchStore();
    store.active = store.active.filter((d) => d.id !== args.id);
    const entry = {
      id: args.id,
      kind: args.kind,
      task_ref: args["task-ref"] || args.task_ref || null,
      memory_log_path: args.log || null,
      agent_assignment: args.agent || null,
      parent_role: args.parent || "implementation",
      started_at: nowIso(),
    };
    store.active.push(entry);
    saveDispatchStore(store);
    printJson({
      ok: true,
      entry,
      description_marker: `[NAM_DISPATCH:${args.id}]`,
    });
    return;
  }
  usage(1);
}

async function cmdInbox(args) {
  const sub = args._[1];
  const inbox = loadManagerInbox();
  if (sub === "list") {
    printJson(inbox);
    return;
  }
  if (sub === "ack") {
    const ref = args["task-ref"] || args.task_ref;
    if (!args.all && !ref) {
      throw new Error("inbox ack requires --all or --task-ref");
    }
    const matches = (e) => args.all || e.task_ref === ref;
    const newlyAcked = inbox.entries.filter((e) => !e.acked && matches(e));
    inbox.entries = inbox.entries.map((e) => (matches(e) ? { ...e, acked: true } : e));
    saveManagerInbox(inbox);
    // Reviewed tasks are done: archive their base forks.
    const forks = [];
    for (const e of newlyAcked) {
      if (!e.agent || !e.queue_id) continue;
      const item = summarizeAgentQueue(e.agent).items.find((i) => i.id === e.queue_id);
      const res = archiveFork(e.agent, item);
      if (!res.noop) forks.push(res);
    }
    printJson({
      ok: true,
      unread: inbox.entries.filter((e) => !e.acked).length,
      ...(forks.length ? { base: { forks_archived: forks } } : {}),
    });
    return;
  }
  usage(1);
}

async function cmdDoctor() {
  const pf = preflight({ force: true });
  printJson(pf);
  if (!pf.ok) process.exitCode = 1;
}

async function cmdHandover(args) {
  const sub = args._[1];
  const agent = args.agent;
  if (!agent) throw new Error("--agent required (Manager or Agent_<Domain>)");
  if (sub === "register") {
    if (!args.file) throw new Error("--file <numbered handover file> required");
    const rel = toProjectRel(args.file);
    const parsed = parseHandoverPath(rel);
    if (!parsed) {
      throw new Error(
        `--file must be a numbered handover file (.nam/Memory/Handovers/<Dir>/<Agent>_Handover_File_<N>.md), never a Runtime pointer. Got: ${rel}`,
      );
    }
    if (!parsed.prefix.toLowerCase().startsWith(agent.toLowerCase())) {
      throw new Error(`${rel} is not a handover file for ${agent}`);
    }
    if (!fs.existsSync(path.join(projectRoot(), rel))) {
      throw new Error(`Handover file not found: ${rel}`);
    }
    const gate = baseGate();
    const handoff = registerHandoff(agent, rel, parsed.number);
    printJson({ ok: true, agent, file: rel, base: { ...gate, handoff } });
    return;
  }
  if (sub === "accept") {
    const handoff = archiveHandoff(agent);
    const pointer = clearHandoverPointer(agent);
    printJson({ ok: true, agent, pointer_cleared: pointer, base: { handoff } });
    return;
  }
  usage(1);
}

async function cmdReconcile(args) {
  printJson(reconcile({ apply: flagBool(args.apply, false) }));
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") usage(0);
  if (cmd === "status") await cmdStatus();
  else if (cmd === "role") await cmdRole(args);
  else if (cmd === "assign") await cmdAssign(args);
  else if (cmd === "queue") await cmdQueue(args);
  else if (cmd === "claim") await cmdClaim(args);
  else if (cmd === "complete") await cmdComplete(args);
  else if (cmd === "dispatch") await cmdDispatch(args);
  else if (cmd === "inbox") await cmdInbox(args);
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "handover") await cmdHandover(args);
  else if (cmd === "reconcile") await cmdReconcile(args);
  else usage(1);
} catch (err) {
  process.stderr.write(`nam-cli error: ${err.message}\n`);
  process.exit(1);
}
