# pr-maintainer-2 — context handoff (2026-06-05 ~10:00Z, pre-shutdown)

Role: senior-dev acting as **PR-queue maintainer / merge-queue keeper** for the
standalone-57% push. Shut down per lead directive (drain to 4 devs for
rate-limiting). Lead is absorbing the queue-keeper role + #1221 gate.

## #1221 state (issue #1897 — standalone test262 regression gate)
- Branch `issue-1897-ci-standalone-gate`. My last push: `8d9eefe3f → 5b59d9117`
  (merged origin/main + remote branch tip; CI-yaml-only, gate logic intact, diff
  scope = only the 4 gate files: `.github/workflows/test262-sharded.yml`,
  `docs/ci-policy.md`, `plan/issues/1897-…md`, `scripts/enable-branch-protection.sh`).
- **Lead has since pushed a further commit — head is now `bf17f6abc`** and lead
  owns it going forward. mss=BLOCKED, NOT in merge queue, fresh CI on new head.
- Gate logic REVIEWED + validated sound: tolerance −15, compile_timeout excluded,
  regression-ONLY (won't block S2's +7.5k jump — large positive net), floor-holding
  via promote-baseline (pins live ~30.6% standalone floor), no branch-protection
  change (rides required "merge shard reports"). Count-extraction greps survive
  `--quiet` (counts are unconditional console.log). Self-validated: its own
  `merge shard reports` passed green on a real run.
- TIMING note in task #331 ("hold until standalone restores to 28-29%") was STALE
  — real standalone is 30.62% (the −1,805 #1898 regression was already fixed via
  #1216 + guard #1222). Lead confirmed: merge anytime is correct.
- To land: when required checks green on `bf17f6abc`, enqueue via GraphQL
  `enqueuePullRequest`. NOTE the recurring wedge (below).

## Merge-queue WEDGE pattern (the recurring operational issue)
- Symptom: queue head sits `AWAITING_CHECKS` indefinitely with NO `merge_group`
  dispatched, blocking everything. Hit ~3× today (89-min, 58-min, 23-min stalls).
  Root cause observed twice: all 30 merge_group shard jobs completed/success but
  the "merge shard reports" check-run stuck reporting `in_progress` (GitHub
  status-propagation glitch, NOT a code bug).
- FIX that works: **dequeue the head + re-enqueue.** `dequeuePullRequest` takes
  the **PR node id** (`gh pr view N --json id -q .id`), NOT the merge-queue entry
  id (entry id gives NOT_FOUND). Then `enqueuePullRequest{pullRequestId}`. Plain
  re-enqueue of a *non-head* entry does NOT fix a wedged head — must remove the
  head entry so a different PR becomes head and GitHub builds a fresh merge_group.
- Refined wedge signal (per lead): head AWAITING_CHECKS >15 min AND all its
  merge_group jobs completed/success → kick. Do NOT kick a head whose merge_group
  is still RUNNING (that's healthy formation; poking it can itself wedge — see
  #1758 in scripts/enqueue-green-prs.mjs header).
- Existing tooling: `scripts/enqueue-green-prs.mjs` (auto-enqueue backstop, 10-min
  cron via `.github/workflows/auto-enqueue.yml`) handles stray-PR enqueue with a
  GRACE window + back-off-while-forming guard — but it deliberately does NOT do
  wedge recovery. **The durable fix is a GitHub Actions workflow for wedge
  recovery** (survives session ends, unlike my bash keepers which kept dying
  across turns — that's why the lead had to kick manually). I drafted but did NOT
  commit a keeper (`/home/node/.claude/jobs/.../qk4.sh`, ephemeral). Recommend
  the lead/a dev land a `recover-wedged-queue.yml` cron with the refined signal.

## My sprint-59 tasks (#66/#86/#87/#90/#93/#97/#101/#103/#105/#116)
- All show `completed` in the TaskList — old finished work, **no live WIP, no
  branches needing follow-up.** Verified both my worktrees clean (0 uncommitted,
  0 unpushed).

## Worktrees (mine — safe to remove after confirming clean)
- `/workspace/.claude/worktrees/pr-maintainer-ops` (branch pr-maintainer-ops,
  e919d5410, clean, 0 unpushed) — scratch ops branch, never PR'd, disposable.
- `/workspace/.claude/worktrees/issue-1897-ci-standalone-gate` (5b59d9117, clean)
  — #1221's worktree; lead now owns the branch, keep until #1221 lands.

## Background processes
All my keepers/watchers (qk4, watch-1221b, confirm-1221-merge, etc.) KILLED before
shutdown — no orphans left running.
