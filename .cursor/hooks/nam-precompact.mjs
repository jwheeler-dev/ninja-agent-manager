#!/usr/bin/env node
/**
 * preCompact — observational sensor for context pressure.
 */
import {
  emit,
  readStdin,
  resolveConversationId,
  runtimePath,
  writeJson,
} from "./nam-lib.mjs";

const input = await readStdin().catch(() => ({}));
const conversationId = resolveConversationId(input);

const pending = {
  trigger: input.trigger || "unknown",
  context_usage_percent: input.context_usage_percent ?? null,
  context_tokens: input.context_tokens ?? null,
  context_window_size: input.context_window_size ?? null,
  message_count: input.message_count ?? null,
  is_first_compaction: input.is_first_compaction ?? null,
  conversation_id: conversationId,
  created_at: new Date().toISOString(),
  nudge_sent: false,
  soft_snapshot_sent: false,
};

writeJson(runtimePath("pending_handover.json"), pending);

const pct =
  typeof pending.context_usage_percent === "number"
    ? `${Math.round(pending.context_usage_percent)}%`
    : "high";

emit({
  user_message: `NAM: context compacting (~${pct}). Manager/Implementation sessions should soft-snapshot if mid-cycle, or run full handover if eligible.`,
});
