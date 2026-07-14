---
name: reference_ci_gate_change_scoped_not_wholetree_absolute
description: "Any CI gate comparing against a frozen WHOLE-TREE absolute baseline is merge-queue-UNSAFE — it auto-parks in merge_group when unrelated PRs grow baselined files on main. Gates must be change-scoped (diff vs merge-base, blame only the change-set's own growth)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

**Lesson (dev-consolidate, #3102 LOC-regrowth ratchet, 2026-07-09).**
A CI gate whose baseline is a **frozen absolute snapshot of the whole tree**
(e.g. "total src LOC ≤ N", or "file X ≤ its size at time T") is
**fundamentally merge-queue-unsafe**:

- PR-level checks pass (the PR didn't grow anything).
- But in the **`merge_group`** re-validation the gate runs against the *merged*
  tree, where **unrelated PRs have since grown baselined files on main**
  (e.g. `generators-native.ts` +926 from another merge). The gate then fails
  `quality` on files **the PR never touched** → `auto-park` `hold`s it →
  queue wedges. This is the same class of hazard as the oracle-bump wedge
  (`[[reference_verdict_logic_change_must_bump_oracle_version]]`) and the
  requeue-cancels-run loop (`[[project_merge_queue_requeue_cancels_run]]`):
  **anything that can fail in merge_group on state the PR didn't change will
  strand PRs.**

**How to apply — make every gate change-scoped, never whole-tree-absolute:**
- Evaluate **only files the change-set modifies**: `git diff --name-only
  $(git merge-base origin/main HEAD)..HEAD` — the merge-base is the **race-free
  fork point** (not `origin/main` HEAD, which drifts).
- Blame a PR **only for its own growth**: guard `cur > size-on-merge-base`
  (a `grew` check), so main's drift on a god-file never fails an unrelated PR.
- Validate the gate against all four: no-src-change branch passes even with a
  drifted baselined file in the merged tree; touch+grow fails; touch+shrink
  passes; ratchet banks the shrink.

**Corollary (false-dead hazard, same PR):** `grep -I` **silently treats a file
with a NUL byte as empty/binary** — `src/runtime-eval.ts` carries a NUL at
offset 19327, so a grep-based "is this export referenced?" scan false-reports
its symbols as dead. Use a **TypeScript AST / node-based** scanner (exact node
spans) for dead-code and reference analysis, not grep.
