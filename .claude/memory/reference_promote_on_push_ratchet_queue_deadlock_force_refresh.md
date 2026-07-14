---
name: reference_promote_on_push_ratchet_queue_deadlock_force_refresh
description: "A merge_group ratchet whose baseline lives in the EXTERNAL js2wasm-baselines repo (re-seeded by promote-baseline ONLY on push-to-main) can DEADLOCK the whole queue: when a merged PR advances main past the baseline, every subsequent PR parks in merge_group, and no push-to-main can promote a new baseline while the queue is wedged. A PR can't fix it (no in-repo baseline file). The sanctioned recovery is the workflow's own force-refresh run on main."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**⚠️ CORRECTION (2026-07-12, same day): the #3189 instance below was NOT a real
main-count deadlock — it was a CI-SHARDED-RUNNER-ONLY artifact.** Main was
genuinely at oob=58; the "+4 → 62" only appeared in the sharded `merge_group`
environment (a runner/env difference), NOT on main. So the force-refresh
correctly promoted 58 (main's real state) and did NOT unwedge. The ACTUAL fix
was a **`TRAP_RATCHET_TOLERANCE` repo var (set =4), wired into the merge_group
ratchet** (`vars.TRAP_RATCHET_TOLERANCE || '0'`), absorbing the CI-only +4 while
keeping the baseline honest at 58 (team commit 8d337dbef2 / #2963). LESSON: the
tell-tale "same +N delta across unrelated PRs, net +0" can be a **sharded-env
artifact**, not a real main regression — VERIFY the count on MAIN itself (not
just merge_group runs) before force-refreshing; if main's count equals the
baseline, a force-refresh won't help and the fix is a tolerance var for the
CI-only noise. The general promote-on-push deadlock mechanism below is still
valid for a GENUINE main-count deadlock, but confirm real-on-main first.

**Diagnosed 2026-07-12 (pr-shepherd), on the #3189 uncatchable-trap ratchet.**

**The deadlock:** the #3189 trap ratchet (and any gate that compares against the
external `loopdive/js2wasm-baselines` jsonl, which `promote-baseline` re-seeds
ONLY on push-to-main, #1528) has **no in-repo baseline file**. When a merged PR
moves main's counts past the last-promoted baseline (here: `oob` traps 58→62,
from #3162/#3183 vec-bounds changes merging after #2949 added the ratchet
without bumping it), EVERY subsequent PR fails the gate in merge_group at
"62 > 58" and auto-parks (`hold` + `auto-park-bot:merge-group-failure`). The
whole queue wedges — and it's a true deadlock: a PR editing a baseline can't fix
it (nothing in-repo to edit), and the normal promotion (push-to-main) can't
happen while the queue is wedged.

**Tell-tale signature (pr-shepherd's diagnosis pattern):** the SAME gate failure
with the SAME test delta across MULTIPLE UNRELATED PRs (none of which touch the
implicated feature), net conformance +0 (zero pass→fail regressions). That means
queue-wide baseline poisoning, NOT per-PR regressions — a lead/dev-level fix, not
a shepherd re-enqueue.

**The sanctioned recovery (verified honest):**
1. FIRST verify net +0 across ≥3 independent merge_group runs (main + unrelated
   PRs) — the failing count is real on main, and there are ZERO pass→fail
   regressions. NEVER force-refresh if a real conformance regression is hiding.
2. Trigger the workflow's own force-refresh ON MAIN:
   `gh workflow run test262-sharded.yml --ref main -f force_baseline_refresh=true -f confirm_force=YES`
   It re-measures main HEAD's ACTUAL state and force-promotes it to the baselines
   repo. Inherently honest: it runs on main, can only promote main's real state,
   can NOT mask a PR regression (unlike hand-bumping a baseline in a PR). ~15-20
   min (full sharded).
3. Once it promotes, every parked PR's next merge_group compares against the new
   baseline and PASSES → shepherd re-enqueues + de-holds the parked PRs (they
   were bot-parked on the poisoned gate, not real regressions).
4. File a P2 FOLLOW-UP to fix the underlying regression properly (here #3202:
   make the 4 TypedArray.prototype.set BigInt/tointeger oob traps throw a
   catchable RangeError) so the ratchet floor drops back to its lower value.

Related: [[feedback_merge_queue_wedge_recovery]], the baselines-repo /
promote-baseline notes in CLAUDE.md (#1528), [[reference_verdict_logic_change_must_bump_oracle_version]]
(the sibling "gate wedges the queue" class). Root prevention: a PR that grows a
promote-on-push ratchet's count must land its baseline bump atomically (or the
ratchet must tolerate the merging PR's own delta).
