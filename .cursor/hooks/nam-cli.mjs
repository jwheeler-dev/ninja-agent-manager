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
  readText,
  resolveConversationId,
  runtimePath,
  saveDispatchStore,
  saveManagerInbox,
  setRole,
  summarizeAgentQueue,
  writeJson,
  writeSoftSnapshot,
  ensureDir,
} from "./nam-lib.mjs";

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

  snapshot write [--notes TEXT] [--conversation ID]
  snapshot show

  inbox list
  inbox ack --all | --task-ref TEXT
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
  const latestSnap = readJson(runtimePath("soft_snapshot_latest.json"), null);
  const pendingHandover = readJson(runtimePath("pending_handover.json"), null);
  printJson({
    conversation_env: process.env.NAM_CONVERSATION_ID || null,
    roles: roles.conversations || {},
    pending_mailboxes: pending,
    unread_inbox: unread.length,
    active_dispatches: dispatch.active,
    soft_snapshot_latest: latestSnap,
    pending_handover: pendingHandover,
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
    printJson(saved);
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
  printJson({
    ok: true,
    enqueued: item,
    pending_count: summary.pending_count,
    user_hint: `Open/reuse ${agent} chat and run /nam-impl — it will claim the next queued task.`,
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
  printJson({
    ok: true,
    ...result,
    tap_path: `.nam/Mailbox/${agent}/${result.item.tap_path}`,
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

async function cmdSnapshot(args) {
  const sub = args._[1];
  if (sub === "show") {
    const latest = readJson(runtimePath("soft_snapshot_latest.json"), null);
    if (!latest?.path) {
      printJson({ snapshot: null });
      return;
    }
    const text = readText(
      path.join(process.cwd(), latest.path.replace(/^\.\//, "")),
    );
    printJson({ ...latest, content: text });
    return;
  }
  if (sub === "write") {
    const id = requireConversation(args);
    const roleState = getRole(id);
    const pending = readJson(runtimePath("pending_handover.json"), null);
    const rel = writeSoftSnapshot({
      conversationId: id,
      roleState,
      pending,
      agentNotes: typeof args.notes === "string" ? args.notes : null,
    });
    printJson({ ok: true, path: rel });
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
    if (args.all) {
      inbox.entries = inbox.entries.map((e) => ({ ...e, acked: true }));
    } else if (args["task-ref"] || args.task_ref) {
      const ref = args["task-ref"] || args.task_ref;
      inbox.entries = inbox.entries.map((e) =>
        e.task_ref === ref ? { ...e, acked: true } : e,
      );
    } else {
      throw new Error("inbox ack requires --all or --task-ref");
    }
    saveManagerInbox(inbox);
    printJson({ ok: true, unread: inbox.entries.filter((e) => !e.acked).length });
    return;
  }
  usage(1);
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
  else if (cmd === "snapshot") await cmdSnapshot(args);
  else if (cmd === "inbox") await cmdInbox(args);
  else usage(1);
} catch (err) {
  process.stderr.write(`nam-cli error: ${err.message}\n`);
  process.exit(1);
}
