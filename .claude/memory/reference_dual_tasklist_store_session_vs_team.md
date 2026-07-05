---
name: reference_dual_tasklist_store_session_vs_team
description: "TaskCreate/TaskList calls from the lead session write to/read a SESSION-scoped store; teammate agents' TaskList calls read the shared \"js2wasm\" TEAM store — same numeric IDs in each are UNRELATED tasks"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

Confirmed 2026-07-02: the lead session's TaskCreate calls (used to dispatch ~10 fresh tasks, IDs #45-#52) were invisible to a spawned teammate's own TaskList call — the teammate's TaskList showed a DIFFERENT set of tasks at those same numeric IDs (old po-triage/#1958 CI-fix items from the shared `js2wasm` team store). This matches CLAUDE.md's documented tech-lead-discipline note: "tasks live in **two stores** (per-session + team `js2wasm`) that don't reconcile each other" — but the collision is sharper than expected: identical IDs, completely unrelated content, with no error or warning on either side.

**Why this matters:** referring a teammate to "task #48" (or any bare numeric task ID) from the lead's own TaskCreate history is meaningless to that teammate if it's checking the shared team store — it'll either find nothing, or worse, find an unrelated task at that number and possibly act on the wrong thing.

**How to apply:** when dispatching work discovered mid-session (e.g. from a fresh measurement/analysis) to a teammate, do NOT rely on a bare task-ID reference across the store boundary. Either (a) give the teammate the full technical brief directly in the spawn/message prompt (issue file path, target import name, measured counts, root-cause pointer) so it's self-contained regardless of which store it reads, or (b) have the teammate allocate its own issue id (`claim-issue.mjs --allocate`) and file a real issue file — issue files under `plan/issues/` are the durable, store-independent shared reference, unlike ephemeral TaskList entries. `node scripts/reconcile-tasklist.mjs` (mentioned in CLAUDE.md) may partially bridge session/team task stores at reconciliation points, but don't rely on it mid-session.
