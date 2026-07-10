---
name: reference_intentional_negative_baseline_strands_inflight_queue_prs
description: "Landing an intentional-negative baseline PR (admin-merge) can park-hold every PR already mid-queue with an identical false-positive regression signature, until the baseline floor refreshes"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

Confirmed 2026-07-02: right after admin-merging `#2463` (a vacuity-scorer intentional-negative baseline correction, −1,433 tests reclassified pass→fail), four unrelated, independently-verified leak-elim PRs already in the merge queue (`#2529`, `#2530`, `#2531`, `#2532`) all got bot park-held within the next ~30 minutes, each citing "check for test262 regressions" / "merge shard reports" failure.

**Diagnostic signature that proves false-positive-from-stale-floor (not a real regression):** all affected PRs show the byte-identical regression-bucket hash and file count (here: `272fadb501354e14`, 1508 files) — four unrelated PRs cannot independently produce the same bucket unless it's an external, shared cause. Cross-reference: (1) the bucket's file list matches the intentional-negative PR's own known delta exactly (here: the TypedArray-wrapper vacuous cluster #2463 was designed to flip); (2) the merge_group runs' baseline source commit predates the intentional-negative PR's merge commit (`git merge-base --is-ancestor <baseline-source-sha> <intentional-negative-merge-sha>` fails); (3) a refreshed baseline floor appears shortly after (check `loopdive/js2wasm-baselines` commit history) whose pass-count arithmetic matches exactly (`old_pass − delta = new_floor_pass`).

**Root cause:** the merge queue's `merge_group` re-validation diffs against whatever baseline floor was current when that specific run started. An admin-merged intentional-negative PR changes the TRUE floor immediately, but the committed/promoted baseline artifact only refreshes on its own promote-baseline cycle (a few minutes later). Any merge_group run that starts in that gap window sees the old floor and misclassifies the intentional-negative delta as "these PRs caused a regression."

**How to apply:** when several PRs park-hold simultaneously right after admin-merging an intentional-negative baseline correction, check for this pattern FIRST before assuming a real code regression: (1) compare regression-bucket signatures/file-lists across all held PRs — identical across unrelated PRs is the tell; (2) confirm the bucket matches the intentional-negative PR's own known delta; (3) confirm a fresher baseline promotion landed after the held runs executed. If confirmed, this is the sanctioned single re-enqueue case per the park-hold protocol ([[feedback_...]] park-hold rules in CLAUDE.md, rule (c)): clear the `hold` label via REST (`gh api -X DELETE repos/.../issues/N/labels/hold` — `gh pr edit` label removal no-ops, see [[reference_gh_remove_label_rest_not_pr_edit]]), then re-enqueue once via the GraphQL `enqueuePullRequest` mutation with the user PAT. Never re-enqueue in a loop.

**Mitigation for next time:** consider holding new PR merge-queue entries briefly (or the shepherd delaying its sweep) for a few minutes after any admin-merge of an intentional-negative baseline PR, to let the promote-baseline cycle complete before other queued PRs hit merge_group — would avoid this stranding pattern proactively instead of diagnosing it reactively.
