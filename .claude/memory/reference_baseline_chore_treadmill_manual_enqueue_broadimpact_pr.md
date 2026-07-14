---
name: reference_baseline_chore_treadmill_manual_enqueue_broadimpact_pr
description: "A broad-impact PR with slow CI (full standalone shards) can get stuck perpetually BEHIND — NOT from coordinator merges but from the automated `[skip ci]` baseline-refresh chore that advances main every ~10 min. auto-enqueue.yml guards on CLEAN so it skips a PR that a chore BEHIND-ed mid-CI. Fix: lead one-shot manually enqueues via enqueuePullRequest (user PAT) the moment it's all-green, before the next chore."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Diagnosed 2026-07-12 (fable-eqfix, on #2922 / #90):** a broad-impact PR
whose CI takes a while (full standalone shards + equivalence) can cycle BEHIND
indefinitely and never enqueue, even when the merge queue is empty and no dev
is merging. Root cause is NOT coordinator/dev merges — it's the **automated
`[skip ci]` baseline-refresh chore that commits to `main` every ~10 min**
(touching only baseline JSON). Every chore bumps `main`, so a PR that was CLEAN
at CI-start is BEHIND by CI-completion. `auto-enqueue.yml` guards on `CLEAN`
(mergeStateStatus), so it **skips** the just-green-but-now-BEHIND PR — and the
dev re-merges, re-runs slow CI, and the next chore catches it again. The
"treadmill."

**Why dormancy makes it worse:** a dev that goes quiet after pushing only wakes
on its OWN CI-completion, not on `main` advancing under it — so it doesn't
re-merge promptly and the PR sits BEHIND for long stretches (see
[[feedback_idle_waiting_agent_not_terminated_dont_reassign_pr]]). Keep the dev
ACTIVELY polling `gh pr view <N> --json mergeStateStatus` every ~60s.

**The fix (lead/shepherd action):** the moment the PR is **all-green**, the
lead **one-shot manually enqueues** it via the `enqueuePullRequest` GraphQL
mutation with the **user PAT** (NOT a re-enqueue loop — a single enqueue).
Manual enqueue takes a BEHIND PR that `auto-enqueue.yml` skips; once it's IN the
queue, `merge_group` rebases it onto current `main` and baseline chores can no
longer displace it. Sequence: dev polls → pings lead "GREEN #<N> head=<sha>" →
lead enqueues that sha immediately (beat the next ~10-min chore).

**Applies to:** any broad-impact / slow-CI PR — the upcoming standalone-family
PRs (#3164/#3132/#2903 R-slices), #90-class value-rep changes, etc. NEVER
re-enqueue in a loop (cancels the in-flight merge_group run —
[[project_merge_queue_requeue_cancels_run]]). Related CI-gotcha: baseline
refresh commits BEHIND every PR (the general note); this is the acute
slow-CI-treadmill case + its manual-enqueue remedy.
