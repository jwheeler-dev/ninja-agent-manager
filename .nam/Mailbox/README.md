# NAM Mailbox / Task Queue

Manager enqueues work; User opens Implementation chats; `/nam-impl` claims and executes.

## Layout

```
.nam/Mailbox/
  Agent_<Domain>/
    queue.json       # FIFO items: pending | claimed | completed
    tasks/<id>.md    # Full Task Assignment Prompt bodies
    pending.md       # Convenience copy of next pending TAP
    claimed.md       # Convenience copy of current claimed TAP
    meta.json        # Convenience pointer to current head
```

## Flow

1. **Manager** enqueues with `node .cursor/hooks/nam-cli.mjs assign --agent … --task-ref … --log … --file tap.md`
2. **Manager tells User** which agent chat to open (does **not** auto-run the task).
3. **User** opens/reuses that chat and runs `/nam-impl`.
4. **Implementation** claims next item (`nam-cli claim`) and executes.
5. On complete: Memory Log + `nam-cli complete` → Manager inbox.
6. **Manager** reviews inbox / log paths, acks, enqueues next work.

See `.nam/Guides/Automation_Guide.md`.
