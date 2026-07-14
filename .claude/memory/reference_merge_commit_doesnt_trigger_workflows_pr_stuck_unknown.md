---
name: reference_merge_commit_doesnt_trigger_workflows_pr_stuck_unknown
description: "After merging origin/main INTO a PR branch to clear a BEHIND, the heavy required workflows (Test262 Sharded, CI/quality) sometimes DON'T trigger on the resulting merge commit — only CLA runs, and the PR sits at mergeStateStatus=UNKNOWN indefinitely (the required check contexts are never CREATED, so the rollup has nothing pending and the PR silently strands). Recovery: push a single EMPTY commit (git commit --allow-empty) to re-trigger — all workflows then fire immediately."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Observed 2026-07-13 (opus-gapmap, on PR #2996/#3228).** After merging
`origin/main` into the branch to clear a BEHIND, the merge commit `77cf8c7c`
triggered ONLY `cla-check` — Test262 Sharded + CI never fired, no
Test262/quality check contexts were created, and `mergeStateStatus` stuck at
**UNKNOWN** for several minutes (rollup had no pending contexts because they were
never created). The PRIOR SHA had been fully green, so it wasn't a real failure —
the workflows just didn't trigger on that merge commit.

**Recovery (works):** push a single empty commit
(`git commit --allow-empty -m "ci: nudge workflows" && git push`) — all 6
workflows fire immediately on the new SHA and go green.

**Why it matters:** this SILENTLY strands a PR at UNKNOWN — it looks like it's
"still computing," but nothing will ever complete because no check contexts
exist. Distinct from a real CI failure or a BEHIND. Symptom to recognize:
mergeStateStatus=UNKNOWN for many minutes, rollup shows only cla-check (no
Test262/quality contexts even pending), on a merge commit. Don't wait it out;
nudge with an empty commit. Likely a GitHub Actions `push`/`pull_request`
trigger race on merge commits. Related strand patterns:
[[reference_setup_node_corepack_flake_parks_pr_as_merge_group_failure]],
[[reference_backgrounded_merge_watcher_dies_strands_agent_on_base_merge]].
