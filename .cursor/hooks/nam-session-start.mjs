#!/usr/bin/env node
/**
 * sessionStart — set NAM_CONVERSATION_ID and inject pending disk context.
 * Runs from Cursor (.cursor/hooks.json), VS Code Copilot (.github/hooks/nam.json)
 * and Claude Code (.claude/settings.json).
 */
import fs from "node:fs";
import { baseDisabled, maybeAutosyncMap, preflight } from "./nam-base.mjs";
import {
  emit,
  listPendingMailboxes,
  normalizeHookInput,
  readJson,
  readStdin,
  readText,
  resolveConversationId,
  runtimePath,
} from "./nam-lib.mjs";

const HANDOVER_POINTER = "active_manager_handover.md";
const IMPL_HANDOVER_POINTER = "active_implementation_handover.md";

/** Code-access guidance plus any base preflight warnings. Never throws. */
function baseContext() {
  if (baseDisabled()) return null;
  let pf;
  try {
    pf = preflight();
  } catch {
    return null;
  }
  const lines = [
    "## Code access (base)",
    "",
    "Find code through the base code map before grep or whole-file reads: `base ast query --file <path>`, `--contains <name>`, `--calls <fn>`, `--imports <path>`. Then read only the lines you need.",
    "Grep is fine for strings, config, dot-directories (not in the map), or when base finds nothing or errors.",
  ];
  if (!pf.ok) {
    lines.push(
      "",
      "base preflight warnings (NAM keeps working; fix when convenient):",
      ...pf.warnings.map((w) => `- ${w}`),
    );
  }
  if (maybeAutosyncMap(pf)) {
    lines.push("", "The code map was over a day old, so a background `base sync --ast` was started.");
  }
  return lines.join("\n");
}

function buildContext(conversationId) {
  const parts = [];
  const basePart = baseContext();

  if (conversationId) {
    parts.push(
      [
        "## NAM session binding",
        "",
        `Conversation id: \`${conversationId}\` (env \`NAM_CONVERSATION_ID\`).`,
        "Register role:",
        "`node .cursor/hooks/nam-cli.mjs role set --role manager|implementation --eligible false`",
        "Prefer CLI for assign/claim/complete/dispatch. See `.nam/Guides/Automation_Guide.md`.",
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

  if (parts.length === 0) return basePart;

  const hasPendingWork =
    Boolean(managerHandover?.trim()) ||
    Boolean(implHandover?.trim()) ||
    pending.length > 0 ||
    (managerInbox?.entries || []).some((e) => !e.acked);

  if (!hasPendingWork && conversationId) {
    return [parts[0], basePart].filter(Boolean).join("\n\n");
  }

  return (
    [
      "# NAM Automation Bootstrap",
      "",
      "Disk-backed NAM dispatch. Prefer CLI + disk over paste.",
      "",
    ].join("\n") + [...parts, basePart].filter(Boolean).join("\n\n")
  );
}

/**
 * Claude Code ignores the hook's `env` output but sources CLAUDE_ENV_FILE
 * into later Bash tool calls, so nam-cli finds NAM_CONVERSATION_ID there.
 */
function exportForClaudeCode(conversationId) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file || !conversationId) return;
  try {
    const safe = String(conversationId).replace(/'/g, "");
    fs.appendFileSync(file, `export NAM_CONVERSATION_ID='${safe}'\n`, "utf8");
  } catch {
    // best effort
  }
}

const input = normalizeHookInput(await readStdin().catch(() => ({})));
const conversationId = resolveConversationId(input);

const out = {};
if (conversationId) {
  out.env = { NAM_CONVERSATION_ID: conversationId };
  exportForClaudeCode(conversationId);
}

const additional_context = buildContext(conversationId);
if (additional_context) out.additional_context = additional_context;

emit(out, "SessionStart");
