import fs from "node:fs";
import path from "node:path";

export function projectRoot() {
  return process.env.CURSOR_PROJECT_DIR || process.cwd();
}

export function namPath(...parts) {
  return path.join(projectRoot(), ".nam", ...parts);
}

export function runtimePath(...parts) {
  return namPath("Runtime", ...parts);
}

export function mailboxPath(...parts) {
  return namPath("Mailbox", ...parts);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readText(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function resolveConversationId(input = {}) {
  return (
    input.conversation_id ||
    input.session_id ||
    process.env.NAM_CONVERSATION_ID ||
    null
  );
}

export function safeConversationKey(conversationId) {
  if (!conversationId) return null;
  return String(conversationId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function loadRolesStore() {
  const store = readJson(runtimePath("roles.json"), { conversations: {} });
  if (!store.conversations || typeof store.conversations !== "object") {
    store.conversations = {};
  }
  return store;
}

export function getRole(conversationId) {
  if (!conversationId) {
    // Legacy fallback for older sessions that only wrote active_role.json
    return readJson(runtimePath("active_role.json"), null);
  }
  const store = loadRolesStore();
  if (store.conversations[conversationId]) {
    return store.conversations[conversationId];
  }
  // Legacy: only if file claims this conversation or has no conversation_id
  const legacy = readJson(runtimePath("active_role.json"), null);
  if (!legacy) return null;
  if (!legacy.conversation_id || legacy.conversation_id === conversationId) {
    return legacy;
  }
  return null;
}

export function setRole(conversationId, patch) {
  if (!conversationId) {
    throw new Error(
      "conversation_id required. Use session env NAM_CONVERSATION_ID or pass --conversation.",
    );
  }
  const store = loadRolesStore();
  const prev = store.conversations[conversationId] || {};
  const next = {
    ...prev,
    ...patch,
    conversation_id: conversationId,
    updated_at: nowIso(),
  };
  store.conversations[conversationId] = next;
  writeJson(runtimePath("roles.json"), store);
  // Mirror latest for humans / older docs
  writeJson(runtimePath("active_role.json"), next);
  return next;
}

export function clearRole(conversationId) {
  if (!conversationId) return;
  const store = loadRolesStore();
  delete store.conversations[conversationId];
  writeJson(runtimePath("roles.json"), store);
}

export function listPendingMailboxes() {
  const root = mailboxPath();
  if (!fs.existsSync(root)) return [];

  const pending = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "Manager") continue;

    const summary = summarizeAgentQueue(entry.name);
    if (!summary || summary.pending_count === 0) continue;

    pending.push({
      agent: entry.name,
      pendingPath: summary.next_pending
        ? `.nam/Mailbox/${entry.name}/${summary.next_pending.tap_path}`
        : `.nam/Mailbox/${entry.name}/pending.md`,
      metaPath: `.nam/Mailbox/${entry.name}/queue.json`,
      taskRef: summary.next_pending?.task_ref || null,
      status: "pending",
      pending_count: summary.pending_count,
      claimed_count: summary.claimed_count,
    });
  }
  return pending;
}

function agentDir(agent) {
  return mailboxPath(agent);
}

function queuePath(agent) {
  return path.join(agentDir(agent), "queue.json");
}

function loadAgentQueue(agent) {
  ensureDir(agentDir(agent));
  const qp = queuePath(agent);
  let store = readJson(qp, null);
  if (!store || !Array.isArray(store.items)) {
    store = { items: [] };
  }

  // Migrate legacy pending.md into queue once
  const legacyPending = path.join(agentDir(agent), "pending.md");
  const legacyMeta = path.join(agentDir(agent), "meta.json");
  if (fs.existsSync(legacyPending) && store.items.length === 0) {
    const meta = readJson(legacyMeta, {});
    const id = "001";
    const tasksDir = path.join(agentDir(agent), "tasks");
    ensureDir(tasksDir);
    const tapRel = `tasks/${id}.md`;
    fs.copyFileSync(legacyPending, path.join(agentDir(agent), tapRel));
    store.items.push({
      id,
      task_ref: meta.task_ref || "Legacy pending assignment",
      status: meta.status === "claimed" ? "claimed" : "pending",
      memory_log_path: meta.memory_log_path || null,
      agent_assignment: agent,
      tap_path: tapRel,
      enqueued_at: meta.updated_at || nowIso(),
      claimed_at: meta.status === "claimed" ? meta.updated_at || null : null,
      completed_at: null,
    });
    writeJson(qp, store);
  }

  return store;
}

function saveAgentQueue(agent, store) {
  writeJson(queuePath(agent), store);
}

export function summarizeAgentQueue(agent) {
  const store = loadAgentQueue(agent);
  const pending = store.items.filter((i) => i.status === "pending");
  const claimed = store.items.filter((i) => i.status === "claimed");
  return {
    agent,
    pending_count: pending.length,
    claimed_count: claimed.length,
    next_pending: pending[0] || null,
    current_claimed: claimed[0] || null,
    items: store.items,
  };
}

export function enqueueAssignment({
  agent,
  taskRef,
  memoryLogPath,
  tapBody,
}) {
  const store = loadAgentQueue(agent);
  const nextNum =
    store.items.reduce((max, item) => {
      const n = parseInt(String(item.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0) + 1;
  const id = String(nextNum).padStart(3, "0");
  const tasksDir = path.join(agentDir(agent), "tasks");
  ensureDir(tasksDir);
  const tapRel = `tasks/${id}.md`;
  fs.writeFileSync(path.join(agentDir(agent), tapRel), tapBody, "utf8");

  const item = {
    id,
    task_ref: taskRef,
    status: "pending",
    memory_log_path: memoryLogPath,
    agent_assignment: agent,
    tap_path: tapRel,
    enqueued_at: nowIso(),
    claimed_at: null,
    completed_at: null,
  };
  store.items.push(item);
  saveAgentQueue(agent, store);

  // Convenience pointers for humans / older readers
  fs.writeFileSync(path.join(agentDir(agent), "pending.md"), tapBody, "utf8");
  writeJson(path.join(agentDir(agent), "meta.json"), {
    task_ref: taskRef,
    status: "pending",
    memory_log_path: memoryLogPath,
    agent_assignment: agent,
    queue_id: id,
    updated_at: nowIso(),
  });

  return item;
}

export function claimNextAssignment(agent, { id } = {}) {
  const store = loadAgentQueue(agent);
  const already = store.items.find((i) => i.status === "claimed");
  if (already && !id) {
    return { item: already, already_claimed: true };
  }

  let item;
  if (id) {
    item = store.items.find((i) => i.id === id && i.status === "pending");
    if (!item) {
      throw new Error(`No pending queue item id=${id} for ${agent}`);
    }
  } else {
    item = store.items.find((i) => i.status === "pending");
    if (!item) {
      throw new Error(`No pending queue items for ${agent}`);
    }
  }

  item.status = "claimed";
  item.claimed_at = nowIso();
  saveAgentQueue(agent, store);

  const absTap = path.join(agentDir(agent), item.tap_path);
  const claimedPath = path.join(agentDir(agent), "claimed.md");
  if (fs.existsSync(absTap)) {
    fs.copyFileSync(absTap, claimedPath);
  }

  writeJson(path.join(agentDir(agent), "meta.json"), {
    task_ref: item.task_ref,
    status: "claimed",
    memory_log_path: item.memory_log_path,
    agent_assignment: agent,
    queue_id: item.id,
    updated_at: nowIso(),
  });

  return { item, already_claimed: false, claimed_path: `.nam/Mailbox/${agent}/claimed.md` };
}

export function completeAssignment(agent, { log, notes, important, compat, adhoc }) {
  const store = loadAgentQueue(agent);
  const item = store.items.find((i) => i.status === "claimed");
  if (!item) {
    throw new Error(`No claimed queue item to complete for ${agent}`);
  }

  item.status = "completed";
  item.completed_at = nowIso();
  if (log) item.memory_log_path = log;
  saveAgentQueue(agent, store);

  const pending = path.join(agentDir(agent), "pending.md");
  if (fs.existsSync(pending)) fs.unlinkSync(pending);

  writeJson(path.join(agentDir(agent), "meta.json"), {
    task_ref: item.task_ref,
    status: "completed",
    memory_log_path: item.memory_log_path,
    agent_assignment: agent,
    queue_id: item.id,
    updated_at: nowIso(),
  });

  appendManagerInbox({
    task_ref: item.task_ref,
    agent,
    memory_log_path: item.memory_log_path || log,
    important_findings: !!important,
    compatibility_issues: !!compat,
    ad_hoc_delegation: !!adhoc,
    notes: notes || "completed via nam-cli",
    queue_id: item.id,
    acked: false,
    completed_at: nowIso(),
  });

  const nextPending = store.items.find((i) => i.status === "pending");
  if (nextPending) {
    const tap = path.join(agentDir(agent), nextPending.tap_path);
    if (fs.existsSync(tap)) {
      fs.copyFileSync(tap, path.join(agentDir(agent), "pending.md"));
    }
    writeJson(path.join(agentDir(agent), "meta.json"), {
      task_ref: nextPending.task_ref,
      status: "pending",
      memory_log_path: nextPending.memory_log_path,
      agent_assignment: agent,
      queue_id: nextPending.id,
      updated_at: nowIso(),
    });
  }

  return { item, next_pending: nextPending || null };
}

export function loadManagerInbox() {
  const inbox = readJson(runtimePath("manager_inbox.json"), { entries: [] });
  if (!Array.isArray(inbox.entries)) inbox.entries = [];
  return inbox;
}

export function saveManagerInbox(inbox) {
  writeJson(runtimePath("manager_inbox.json"), inbox);
}

export function appendManagerInbox(entry) {
  const inbox = loadManagerInbox();
  inbox.entries.push(entry);
  saveManagerInbox(inbox);
}

export function loadDispatchStore() {
  const raw = readJson(runtimePath("task_dispatch.json"), {
    active: [],
    completed: [],
  });
  let active = raw.active;
  if (!Array.isArray(active)) active = active ? [active] : [];
  let completed = raw.completed;
  if (!Array.isArray(completed)) completed = completed ? [completed] : [];
  return { active, completed };
}

export function saveDispatchStore(store) {
  writeJson(runtimePath("task_dispatch.json"), store);
}

export function writeSoftSnapshot({
  conversationId,
  roleState,
  pending,
  agentNotes,
}) {
  const key = safeConversationKey(conversationId) || "unknown";
  const dir = runtimePath("soft_snapshots");
  ensureDir(dir);
  const rel = `.nam/Runtime/soft_snapshots/${key}.md`;
  const abs = runtimePath("soft_snapshots", `${key}.md`);

  const mailboxes = listPendingMailboxes();
  const inbox = loadManagerInbox();
  const unread = inbox.entries.filter((e) => !e.acked).slice(-8);
  const dispatch = loadDispatchStore();

  const body = [
    `# NAM Soft Snapshot`,
    ``,
    `> Auto-written under context pressure while full handover was not eligible.`,
    `> Enrich the **Agent notes** section, then continue. Run full handover when the cycle completes.`,
    ``,
    `- **conversation_id:** ${conversationId || "unknown"}`,
    `- **role:** ${roleState?.role || "unknown"}`,
    `- **agent_name:** ${roleState?.agent_name || "n/a"}`,
    `- **handover_eligible:** ${roleState?.handover_eligible ?? "n/a"}`,
    `- **role_notes:** ${roleState?.notes || "(none)"}`,
    `- **created_at:** ${nowIso()}`,
    `- **context_usage_percent:** ${pending?.context_usage_percent ?? "n/a"}`,
    `- **pending_handover_trigger:** ${pending?.trigger || "n/a"}`,
    ``,
    `## In-flight mailboxes`,
    ``,
    mailboxes.length
      ? mailboxes.map((m) => `- ${m.agent}: \`${m.pendingPath}\` (${m.taskRef || "no task_ref"})`).join("\n")
      : "- (none)",
    ``,
    `## Unread manager inbox`,
    ``,
    unread.length
      ? unread
          .map(
            (e) =>
              `- ${e.task_ref || "task"} → \`${e.memory_log_path}\`${e.agent ? ` (${e.agent})` : ""}`,
          )
          .join("\n")
      : "- (none)",
    ``,
    `## Active Task-tool dispatches`,
    ``,
    dispatch.active.length
      ? dispatch.active
          .map(
            (d) =>
              `- \`${d.id}\` kind=${d.kind} task=${d.task_ref || "n/a"}`,
          )
          .join("\n")
      : "- (none)",
    ``,
    `## Agent notes (enrich on soft-snapshot followup)`,
    ``,
    agentNotes?.trim() ||
      "_Waiting on agent enrichment: blocking step, in-flight task id, resume instructions, anything not yet in Memory Logs._",
    ``,
    `## Resume checklist`,
    ``,
    `1. Finish the blocking cycle step (task / Memory Log / review).`,
    `2. Set handover_eligible via CLI when eligible.`,
    `3. Run \`/nam-handover-manager\` or \`/nam-handover-impl\`.`,
    ``,
  ].join("\n");

  fs.writeFileSync(abs, body, "utf8");
  writeJson(runtimePath("soft_snapshot_latest.json"), {
    conversation_id: conversationId || null,
    path: rel,
    role: roleState?.role || null,
    updated_at: nowIso(),
  });
  return rel;
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

export function readStdinText() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}
