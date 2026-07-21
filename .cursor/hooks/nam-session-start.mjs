#!/usr/bin/env node
/**
 * sessionStart — set NAM_CONVERSATION_ID and inject pending disk context.
 */
import {
  emit,
  listPendingMailboxes,
  readJson,
  readStdin,
  readText,
  resolveConversationId,
  runtimePath,
} from "./nam-lib.mjs";

const HANDOVER_POINTER = "active_manager_handover.md";
const IMPL_HANDOVER_POINTER = "active_implementation_handover.md";

function buildContext(conversationId) {
  const parts = [];

  if (conversationId) {
    parts.push(
      [
        "## NAM session binding",
        "",
        `Conversation id: \`${conversationId}\` (env \`NAM_CONVERSATION_ID\`).`,
        "Register role:",
        "`node .cursor/hooks/nam-cli.mjs role set --role manager|implementation --eligible false`",
        "Prefer CLI for assign/claim/complete/dispatch/snapshot. See `.nam/Guides/Automation_Guide.md`.",
      ].join("\n"),
    );
  }

  const managerHandover = readText(runtimePath(HANDOVER_POINTER));
  if (managerHandover && managerHandover.trim()) {
    parts.push(
      [
        "## Pending Manager Handover (disk)",
        "",
        "If initializing via `/nam-manager` and Memory Root has project content,",
        "**do not ask the User to paste.** Read `.nam/Runtime/active_manager_handover.md`.",
        "",
        "```markdown",
        managerHandover.trim(),
        "```",
      ].join("\n"),
    );
  }

  const pending = listPendingMailboxes();
  const implHandover = readText(runtimePath(IMPL_HANDOVER_POINTER));
  const hasImplHandover = Boolean(implHandover?.trim());

  if (pending.length > 0) {
    const lines = pending.map(
      (p) =>
        `- **${p.agent}**: ${p.pending_count || 1} queued` +
        `${p.taskRef ? ` — next: ${p.taskRef}` : ""} (\`${p.pendingPath}\`)`,
    );
    const priorityNote = hasImplHandover
      ? [
          "",
          "**PRIORITY:** Live mailbox queue beats a stale Implementation handover.",
          "If `/nam-impl` for a listed agent: **claim and execute** the pending TAP.",
          "Do **not** run multi-step handover confirmation when pending work exists.",
          "Clear `.nam/Runtime/active_implementation_handover.md` after claiming (or if assign already cleared it).",
          "Treat handover text saying \"queue empty\" as outdated.",
        ]
      : [];
    parts.push(
      [
        "## Implementation task queue",
        "",
        "Open/reuse the matching agent chat and run `/nam-impl`.",
        "That agent will claim the next queued task automatically (Manager does not auto-run plan tasks).",
        "Claim: `node .cursor/hooks/nam-cli.mjs claim --agent <Agent>`",
        ...priorityNote,
        "",
        ...lines,
      ].join("\n"),
    );
  }

  if (hasImplHandover) {
    parts.push(
      [
        "## Pending Implementation Handover (disk)",
        "",
        pending.length > 0
          ? "Superseded for agents with pending queue items — claim queue first; skim this only for agent name / last completed task."
          : "If initializing via `/nam-impl` and this targets your agent (and **no** pending queue item), load `.nam/Runtime/active_implementation_handover.md` instead of paste.",
        "",
        "```markdown",
        implHandover.trim(),
        "```",
      ].join("\n"),
    );
  }

  const softLatest = readJson(runtimePath("soft_snapshot_latest.json"), null);
  if (softLatest?.path) {
    const softFromCwd = readText(softLatest.path);
    if (softFromCwd && softFromCwd.trim()) {
      parts.push(
        [
          "## Soft snapshot (context-pressure mid-cycle)",
          "",
          `Latest soft snapshot at \`${softLatest.path}\`.`,
          "If resuming after compaction, read and honor the resume checklist.",
          "",
          "```markdown",
          softFromCwd.trim().slice(0, 6000),
          "```",
        ].join("\n"),
      );
    }
  }

  const managerInbox = readJson(runtimePath("manager_inbox.json"), null);
  if (managerInbox?.entries?.length) {
    const unread = managerInbox.entries.filter((e) => !e.acked);
    if (unread.length > 0) {
      const lines = unread.slice(-5).map(
        (e) =>
          `- ${e.task_ref || "task"} → \`${e.memory_log_path}\`${e.agent ? ` (${e.agent})` : ""}`,
      );
      parts.push(
        [
          "## Manager Inbox (unread completions)",
          "",
          "Managers: review by path, then `node .cursor/hooks/nam-cli.mjs inbox ack --task-ref \"...\"` or `--all`.",
          "",
          ...lines,
        ].join("\n"),
      );
    }
  }

  if (parts.length === 0) return null;

  const hasPendingWork =
    Boolean(managerHandover?.trim()) ||
    Boolean(implHandover?.trim()) ||
    Boolean(softLatest?.path) ||
    pending.length > 0 ||
    (managerInbox?.entries || []).some((e) => !e.acked);

  if (!hasPendingWork && conversationId) {
    return parts[0];
  }

  return (
    [
      "# NAM Automation Bootstrap",
      "",
      "Disk-backed NAM dispatch. Prefer CLI + disk over paste.",
      "",
    ].join("\n") + parts.join("\n\n")
  );
}

const input = await readStdin().catch(() => ({}));
const conversationId = resolveConversationId(input);

const out = {};
if (conversationId) {
  out.env = { NAM_CONVERSATION_ID: conversationId };
}

const additional_context = buildContext(conversationId);
if (additional_context) out.additional_context = additional_context;

emit(out);
