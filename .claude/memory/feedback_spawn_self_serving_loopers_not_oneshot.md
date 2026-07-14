---
name: feedback_spawn_self_serving_loopers_not_oneshot
description: "Spawn Fable/dev agents as persistent self-serving LOOPERS (claim next high-ROI rock when their PR merges), NOT one-shot subagents that stand down after each PR. Standing down drains the fleet + adds re-dispatch overhead; the user wants a steady N devs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
---

The user (2026-07-09) flagged twice — "why do we no longer have 4 fable devs" +
"why did they stand down instead of self serving from the tasklist" — that
task-scoped subagents which stand down after one PR are the wrong model. They
create a **drain/refill gap** (fleet thins to 0–2 while the lead re-dispatches)
and waste lead attention.

**Why:** the user wants a steady target size (e.g. 4 Fable devs) working
continuously, not a hand-fed one-rock-at-a-time cycle.

**How to apply:**
- Spawn each dev with a **LOOP instruction**: when your PR self-merges, DON'T
  stand down — `git fetch origin main`, claim the next rock (`claim-issue`,
  respect the lock/skip if owned), verify-first → implement → /dev-self-merge,
  repeat; keep each rock's context lean; stand down only when no suitable rock
  is unclaimed or the lead sends shutdown. A no-`team_name` subagent CAN loop
  across many rocks in one invocation (it just doesn't return until dry).
- **CURATE the pull-pool — do NOT rely on blind self-serve.** The
  `status: ready` + `feasibility: hard` pool contains ~25 rocks but many are
  **stale moonshots** (#1032 compile-axios, #1033 compile-react, #1058
  compile-tsc, #1066 eval, #1099 standalone-demo, #1584 gc-interpreter) that a
  blind claim would wrongly pull. The native auto-dispatcher offers *any*
  ownerless task and does **not** rank by conformance-ROI. So the loop
  instruction must NAME the target pool (the recent #3xxx substrate/conformance
  line + architect-filed rocks + value-rep/iterator/Proxy/TA/BigInt/IR-keystone
  follow-ups) and an explicit SKIP-list of the moonshots. Keep the high-ROI
  rocks tagged `model: fable` + `priority: high` so the curated pool is
  self-evident. Related: [[feedback_dev_self_serve_tasklist.md]],
  [[feedback_tasklist_always_populated.md]], [[feedback_devs_default_opus.md]]
  (devs default fable this window).
