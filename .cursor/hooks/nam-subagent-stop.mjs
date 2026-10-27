#!/usr/bin/env node
/**
 * subagentStop — close the loop on NAM Task-tool dispatches.
 * Matches descriptions containing [NAM_DISPATCH:<id>] and nudges the parent.
 */
import fs from "node:fs";
import path from "node:path";
import {
  emit,
  ensureDir,
  normalizeHookInput,
  readJson,
  readStdin,
  runtimePath,
  writeJson,
} from "./nam-lib.mjs";

const DISPATCH_RE = /\[NAM_DISPATCH:([^\]]+)\]/;

function loadDispatch() {
  const raw = readJson(runtimePath("task_dispatch.json"), {
    active: [],
    completed: [],
  });
  let active = raw.active;
  if (!Array.isArray(active)) {
    active = active ? [active] : [];
  }
  let completed = raw.completed;
  if (!Array.isArray(completed)) {
    completed = completed ? [completed] : [];
  }
  return { active, completed };
}

function saveDispatch(data) {
  writeJson(runtimePath("task_dispatch.json"), data);
}

function writeResultFile(id, payload) {
  const dir = runtimePath("task_results");
  ensureDir(dir);
  const file = path.join(dir, `${id}.md`);
  const body = [
    `# NAM Task Result - ${id}`,
    "",
    `- **kind:** ${payload.kind || "unknown"}`,
    `- **status:** ${payload.status}`,
    `- **subagent_type:** ${payload.subagent_type || "n/a"}`,
    `- **task_ref:** ${payload.task_ref || "n/a"}`,
    `- **memory_log_path:** ${payload.memory_log_path || "n/a"}`,
    `- **completed_at:** ${payload.completed_at}`,
    "",
    "## Summary",
    "",
    payload.summary || "(no summary)",
    "",
    "## Modified files",
    "",
    ...(payload.modified_files || []).map((f) => `- \`${f}\``),
    (payload.modified_files || []).length === 0 ? "- (none reported)" : "",
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return `.nam/Runtime/task_results/${id}.md`;
}

function appendManagerInbox(entry) {
  const file = runtimePath("manager_inbox.json");
  const inbox = readJson(file, { entries: [] });
  if (!Array.isArray(inbox.entries)) inbox.entries = [];
  inbox.entries.push(entry);
  writeJson(file, inbox);
}

const input = normalizeHookInput(await readStdin().catch(() => ({})));
const status = input.status || "unknown";
const description = input.description || "";
const taskText = input.task || "";
const match =
  description.match(DISPATCH_RE) || taskText.match(DISPATCH_RE);

if (!match) {
  emit({});
  process.exit(0);
}

const dispatchId = match[1].trim();
const store = loadDispatch();
const active = Array.isArray(store.active) ? store.active : [];
const idx = active.findIndex((d) => d.id === dispatchId);
const record =
  idx >= 0
    ? active[idx]
    : {
        id: dispatchId,
        kind: "unknown",
        task_ref: null,
        memory_log_path: null,
        parent_role: null,
      };

if (idx >= 0) {
  active.splice(idx, 1);
  store.active = active;
}

const completed_at = new Date().toISOString();
const resultPath = writeResultFile(dispatchId, {
  kind: record.kind,
  status,
  subagent_type: input.subagent_type,
  task_ref: record.task_ref,
  memory_log_path: record.memory_log_path,
  summary: input.summary || "",
  modified_files: input.modified_files || [],
  completed_at,
});

const completedEntry = {
  ...record,
  status,
  result_path: resultPath,
  completed_at,
  summary: input.summary || "",
};
store.completed = Array.isArray(store.completed) ? store.completed : [];
store.completed.push(completedEntry);
// Keep last 40 completions
if (store.completed.length > 40) {
  store.completed = store.completed.slice(-40);
}
saveDispatch(store);

if (status !== "completed") {
  emit({
    followup_message: [
      `NAM Task-tool dispatch \`${dispatchId}\` ended with status \`${status}\`.`,
      `Read \`${resultPath}\` and decide whether to redelegate, escalate, or fall back to mailbox/chat.`,
      `Do not invent success.`,
    ].join(" "),
  }, "SubagentStop");
  process.exit(0);
}

const kind = record.kind || "unknown";

if (kind === "plan_task" && record.memory_log_path) {
  appendManagerInbox({
    task_ref: record.task_ref || dispatchId,
    agent: record.agent_assignment || "Task_Subagent",
    memory_log_path: record.memory_log_path,
    important_findings: false,
    compatibility_issues: false,
    ad_hoc_delegation: false,
    notes: `Task-tool dispatch completed. Result: ${resultPath}`,
    dispatch_id: dispatchId,
    result_path: resultPath,
    acked: false,
    completed_at,
  });

  emit({
    followup_message: [
      `NAM single-step Task-tool dispatch \`${dispatchId}\` completed.`,
      `Review Memory Log \`${record.memory_log_path}\` and result \`${resultPath}\`.`,
      `Mark the manager inbox entry acked, then continue the Task Loop (next mailbox or Task-tool assignment as eligible).`,
    ].join(" "),
  }, "SubagentStop");
  process.exit(0);
}

if (kind === "adhoc_research" || kind === "adhoc_debug") {
  emit({
    followup_message: [
      `NAM ${kind} Task-tool dispatch \`${dispatchId}\` completed.`,
      `Integrate findings from \`${resultPath}\` (and the subagent summary) into the parent task.`,
      `Document the delegation in the Memory Log. Redelegate only if findings are inadequate.`,
    ].join(" "),
  }, "SubagentStop");
  process.exit(0);
}

emit({
  followup_message: [
    `NAM Task-tool dispatch \`${dispatchId}\` completed.`,
    `Read \`${resultPath}\` and continue.`,
  ].join(" "),
}, "SubagentStop");
