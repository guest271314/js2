---
name: feedback_budget_is_own_agents_pipeline_not_idle
description: "In a multi-session swarm, MY token budget = MY spawned agents + my orchestration only; pipeline agents (next slice during CI-wait) so the budget produces output, not idle-poll"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When the user gives a budget-utilization directive ("use the remaining X% over N days"),
two corrections learned in sprint 63 (2026-06-18):

**1. My budget = MY agents only.** The js2wasm team is shared across many concurrent
Claude driver sessions. The parallel sessions burn THEIR OWN budget — their PRs landing
does NOT consume mine. So "is there enough work to use my 22%" really means "can MY 3-4
spawned agents stay productively busy." Parallel work becomes a LIABILITY (something to
avoid duplicating — a duplicated PR wastes MY budget on already-done work), not a help.
Verify-before-claim (`gh pr list --search`, git ancestry, claim locks) on every assignment.

**2. Idle-in-CI-wait burns ~zero budget — PIPELINE instead.** A senior agent "blocking on
CI quietly" (background watcher polling the ~30-min 114-shard matrix) consumes almost no
tokens. That's good hygiene but TERRIBLE for budget utilization. To actually spend the
budget on useful output, switch agents from idle-wait to **pipelining**: start the NEXT
slice (fresh worktree) while the current PR's CI runs in the background; the watcher still
auto-enqueues the finished PR. Bias toward deep architect-scale epics (more compute per
slice than quick fixes). Zero idle gaps = budget actually used.

**Why:** the earlier stall (devs went idle, I read silence as "healthy CI-wait" and
over-held a no-spawn posture) wasted the window. The fix that worked: reset to a fresh
fleet, pipeline every agent, keep a self-refilling queue (re-harvest), and catch each
unblock/rebase trigger as PRs land so nothing stalls. See [[feedback_no_shared_worktree_assignment]],
[[feedback_verify_fix_in_git_not_narrative]], [[feedback_dev_silence_protocol]].

**Green-riding ≠ done — redirect immediately (sprint 63→64, 2026-06-19).** The sharp
trigger: the MOMENT a dev's PR is green-riding (CI passing, the dev's background watcher
+ the merge queue will land it with zero dev attention), the dev must START THE NEXT
SLICE — claim/harvest in a fresh worktree. Waiting for your own PR to "land" produces
nothing; the watcher owns that. The user caught me letting two senior-devs idle-ping while
their +38 / 72-flip PRs rode to green — they should have been pipelining the next
(adjacent, context-warm) slice. **Tech-lead duty:** redirect a dev to its next slice the
instant its PR goes green-riding; do NOT wait for the merge. **Signal to watch:** a stream
of idle pings *while a PR is "in CI"* = the dev is NOT pipelining (it's the same idle
signature as a stuck agent) — redirect it to claim the next task, don't read it as healthy
CI-wait. This is now encoded in `.claude/agents/developer.md` step 5 (pipeline, don't
"stop and wait"). The natural next slice is often the one the just-finished PR UNBLOCKED
(e.g. a receiver-representation PR unblocks the rest of the dynamic-object family) — spend
that context while it's warm.

**How to apply:** on a budget directive — (a) count only your own agents; (b) tell them to
pipeline (next slice during CI-wait, don't idle-poll); (c) re-harvest to keep the queue
deep; (d) verify-before-claim against parallel sessions; (e) green-light deep epics as the
heaviest consumers. Re-poll agent liveness rather than assuming silence = working.
