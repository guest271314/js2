---
name: reference_backgrounded_merge_watcher_dies_strands_agent_on_base_merge
description: "When an agent sequences a same-file next-slice by PARKING on a backgrounded bash watcher for its BASE PR to merge, the watcher dies with the reaped process, so when the base actually merges the agent is NEVER re-invoked → it sits idle for hours, having silently produced nothing. Symptom: agent's task .output mtime goes stale (2–6h) with NO new PR after its base merged, load unexpectedly low. Recovery: SendMessage the agent directly (resumes it from transcript, bypassing the dead watcher). Prevention: don't let agents re-park on a backgrounded watcher for the base-merge; the LEAD proactively re-engages the waiting agent the moment its base PR merges (or dispatches the next slice fresh)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Diagnosed 2026-07-13 (lead) — caught THREE agents stranded simultaneously
(opus-delete/atan, opus-r4/R4b, opus-3201b/join-for-of).** All three had
finished a slice on a hotspot file (`math-helpers.ts`, `array-methods.ts`,
`calls.ts`), and — to avoid a same-file self-conflict — each parked waiting for
its just-opened PR to MERGE before branching the NEXT slice from fresh main,
using a **backgrounded bash merge-watcher** (`while ! merged; do sleep; done`)
plus "go quiet." The base PRs all merged. But the watchers had **died with the
reaped agent process**, so the merge event never re-invoked any of them → all
three sat idle 2.5–5.5h producing nothing, while the lead believed they were
building.

**How it was caught:** the lead health-checked agent liveness via task
`.output` mtime (`stat -c %Y` on `<taskdir>/<agentId>.output`, without reading
the transcript). Stale mtimes (329/173/151 min) + no open PRs from the fleet +
unexpectedly low load (~2.4) = stranded, not building. Confirmed by checking the
worktree HEAD (a plain "Merge origin/main" commit, no next-slice work) and that
the base PR had already merged hours earlier.

**⚠ CAVEAT — stale mtime ALONE is NOT a stall (false-positive seen same day):**
a long FOREGROUND command (full compile/test suite, a bit-exact 2851-comparison
sweep) freezes the agent's `.output` mtime for 20–75 min while the agent is
perfectly healthy. Before concluding "stalled," CONFIRM with worktree activity:
`git -C <wt> log -1 --format=%cr` (recent commit?), `git status --porcelain`
(dirty files = actively editing?), and `pgrep -fc vitest/tsc/esbuild` (live
compiles?). Stranded = stale mtime **AND** worktree HEAD is a plain merge commit
with no dirty files **AND** no live compiles **AND** the base PR already merged.
If the worktree has recent commits / dirty files, or vitest/tsc are running, the
agent is on a long command — LEAVE IT, do not re-engage (re-engaging mid-command
is disruptive). Load is a tell: genuinely-stranded fleet → load unexpectedly LOW;
healthy-but-quiet fleet → load elevated from the compiles.

**Recovery (works):** `SendMessage` the stalled agent directly — the harness
reports "had no active task; resumed from transcript" and re-invokes it,
bypassing the dead watcher. It picks up its recorded next-slice plan and
proceeds. (Resume runs on the LEAD model, fine when the agent is already opus —
see [[reference_resume_runs_lead_model_not_agent_fable]].) If it can't progress
(truly wedged / deep-budget), dispatch the next slice FRESH.

**Prevention / orchestration change:** for same-file serialized slices, do NOT
trust an agent's backgrounded merge-watcher to sequence the next slice. Either
(a) the LEAD proactively SendMessages the waiting agent the instant its base PR
merges (the lead sees merges on its loop reground), or (b) the agent opens its
PR and STANDS DOWN, and the next slice is dispatched fresh from merged main.
Add "check fleet .output mtimes; re-engage any stale agent whose base PR merged"
to the loop-tick routine. Same root family as
[[feedback_background_teammate_shutdown_limitation]] (backgrounded watchers /
BG-teammate lifecycle die outside the agent's own turn) and the #2225/#2247
"CI-watcher dies on stand-down → green PR strands" class that moved enqueue
server-side (#2786). Here it's the SEQUENCING watcher, not the enqueue watcher,
but the failure is identical.
