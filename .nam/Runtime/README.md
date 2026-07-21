# NAM Runtime State

Ephemeral coordination flags for Cursor hooks and disk-backed dispatch.

| File | Writer | Purpose |
|------|--------|---------|
| `roles.json` | CLI `role set` | Per-conversation role + handover_eligible |
| `active_role.json` | CLI (mirror of latest role write) | Convenience mirror |
| `pending_handover.json` | `preCompact` hook | Context-pressure sensor |
| `soft_snapshots/*.md` | `stop` / CLI `snapshot write` | Mid-cycle salvage under compaction |
| `soft_snapshot_latest.json` | soft snapshot writer | Pointer to latest soft snapshot |
| `active_manager_handover.md` | Outgoing Manager (`/nam-handover-manager`) | Pointer so `/nam-manager` loads handover without paste |
| `active_implementation_handover.md` | Outgoing Implementation (`/nam-handover-impl`) | Pointer so `/nam-impl` loads handover without paste |
| `manager_inbox.json` | Implementation / CLI `complete` | Path-only completion notifications for Manager |
| `task_dispatch.json` | CLI `dispatch register` | Active + completed Task-tool dispatches |
| `task_results/<id>.md` | `subagentStop` hook | Summary when a NAM-tagged Task subagent finishes |

CLI: `node .cursor/hooks/nam-cli.mjs …` — see `.nam/Guides/Automation_Guide.md`.
