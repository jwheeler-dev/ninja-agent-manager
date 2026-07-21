# NAM 1.0 (Ninja Agent Manager) - Memory System Guide 
This guide explains how NAM sessions store and evolve memory using the **Dynamic-MD** system.

Memory duties are assigned to the *Manager Agent* - who maintains the system. Details on individual Memory Log files reside in .nam/Guides/Memory_Log_Guide.md.

## 1  Memory System Overview
The Dynamic-MD Memory System organizes memory with the following structure:

- **Storage layout:** Folder `.nam/Memory/` + `Memory_Root.md` + sub-folders `Phase_XX_<slug>/` in the `.nam/` directory
- **Log format:** One `Task_XX_<slug>.md` Memory Log per task
- **Summarization:** After each phase completes, an inline subsection is appended to the `Memory_Root.md` file summarizing the phase

**Memory Logs** capture granular, task-level context and are written by Implementation Agents after each task completion. See .nam/Guides/Memory_Log_Guide.md for schemas and writing rules.

## 2  Manager Agent Responsibilities
Main responsibilities of the Manager Agent when maintaining the Memory System during a NAM session:

1. **Memory Root Header Initialization (First Session Only)**: Before starting the first phase execution, fill in the header of `.nam/Memory/Memory_Root.md`. The file ships with a header template containing placeholders (created during project/NAM setup). Replace all placeholders with actual values before proceeding to phase execution.

2. Keep the Memory System structure (folders/logs) in sync with the current Implementation Plan. Update as Phases or Tasks change.

3. After each phase, create and append a concise summary referencing the relevant Memory Logs.

### Phase and Task Management
**Note**: The Memory Root header must be filled before the first phase execution begins (see responsibility #1 above).

1. On phase entry, create `.nam/Memory/Phase_XX_<slug>/` if missing. For each task in the phase, create a **completely empty** Memory Log, following .nam/Guides/Memory_Log_Guide.md:
    - `Task_Y_Z_<slug>.md`

**All Memory Logs for the current phase must be created BEFORE the first Task Assignment Prompt for each task.**
**Use task ID and title from Implementation Plan (exclude agent assignment).**
**Example: Task "Task 2.1 - Deploy Updates | Agent_Backend" → `Task_2_1_Deploy_Updates.md`**

2. After each task execution, review the Memory Log **populated by the Implementation Agent** (via `.nam/Runtime/manager_inbox.json` path or User notice).
   - If the log contains `important_findings: true` or `compatibility_issues: true`, you **MUST** inspect the referenced output files/artifacts to validate the findings before making a decision.
   

3. At phase end, append a summary to `.nam/Memory/Memory_Root.md`:
    ```markdown
    ## Phase XX - <Phase Name> Summary 
    * Outcome summary (≤ 200 words)
    * List of involved Agents
    * Links to all phase task logs
    ```
    Keep summaries ≤30 lines.

---

**End of Guide**