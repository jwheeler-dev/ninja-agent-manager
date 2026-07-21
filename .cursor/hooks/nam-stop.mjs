#!/usr/bin/env node
/**
 * stop — context-pressure followups:
 * - eligible → full handover nudge
 * - ineligible but NAM role → soft snapshot + enrich followup
 */
import {
  emit,
  getRole,
  readJson,
  readStdin,
  resolveConversationId,
  runtimePath,
  writeJson,
  writeSoftSnapshot,
} from "./nam-lib.mjs";

const input = await readStdin().catch(() => ({}));
const status = input.status || "completed";
const loopCount = input.loop_count ?? 0;
const conversationId = resolveConversationId(input);

if (status !== "completed" || loopCount > 0) {
  emit({});
  process.exit(0);
}

const pendingPath = runtimePath("pending_handover.json");
const pending = readJson(pendingPath, null);
if (!pending) {
  emit({});
  process.exit(0);
}

// Prefer conversation match when both sides have ids
if (
  pending.conversation_id &&
  conversationId &&
  pending.conversation_id !== conversationId
) {
  emit({});
  process.exit(0);
}

const roleState = getRole(conversationId || pending.conversation_id);
const role = roleState?.role || null;

if (!role || (role !== "manager" && role !== "implementation")) {
  emit({});
  process.exit(0);
}

const pct =
  typeof pending.context_usage_percent === "number"
    ? `${Math.round(pending.context_usage_percent)}%`
    : "elevated";

const eligible = roleState?.handover_eligible === true;
const command =
  role === "manager"
    ? "/nam-handover-manager"
    : "/nam-handover-impl";

if (eligible) {
  if (pending.nudge_sent) {
    emit({});
    process.exit(0);
  }
  pending.nudge_sent = true;
  pending.nudge_at = new Date().toISOString();
  pending.nudge_role = role;
  writeJson(pendingPath, pending);

  emit({
    followup_message: [
      `NAM automation: context pressure detected (~${pct} before compaction).`,
      `You are registered as a NAM ${role} agent for this conversation.`,
      `Run ${command} now and write disk pointers per Automation Guide.`,
      `If suddenly blocked mid-cycle, set eligible false via CLI and soft-snapshot instead.`,
    ].join(" "),
  });
  process.exit(0);
}

// Ineligible: soft snapshot path
if (pending.soft_snapshot_sent) {
  emit({});
  process.exit(0);
}

const snapConv = conversationId || pending.conversation_id || "unknown";
const snapPath = writeSoftSnapshot({
  conversationId: snapConv,
  roleState,
  pending,
  agentNotes: null,
});

pending.soft_snapshot_sent = true;
pending.soft_snapshot_at = new Date().toISOString();
pending.soft_snapshot_path = snapPath;
writeJson(pendingPath, pending);

emit({
  followup_message: [
    `NAM automation: context pressure (~${pct}) while handover is not eligible.`,
    `A soft snapshot stub was written to \`${snapPath}\`.`,
    `Enrich it now: \`node .cursor/hooks/nam-cli.mjs snapshot write --notes "blocking step + in-flight task + resume instructions"\`.`,
    `Then continue the blocking step. When the cycle completes, set \`role set --eligible true\` and run ${command}.`,
    `Do not invent unrelated work.`,
  ].join(" "),
});
