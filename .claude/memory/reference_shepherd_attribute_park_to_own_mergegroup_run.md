---
name: reference_shepherd_attribute_park_to_own_mergegroup_run
description: "PR-shepherd — attribute an auto-park to the PR's OWN merge_group run, not a cited run; two held PRs can be two independent regressions in different lanes"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

When diagnosing an auto-parked PR, find the merge_group run whose branch is
`gh-readonly-queue/main/pr-<THIS-PR>-<sha>` and read the auto-park comment's
"Failed checks" line — do NOT trust a charter/hand-off that names a single
shared run. Multiple PRs queued back-to-back each get their OWN merge_group run;
a charter can cite the wrong one.

Worked example (2026-06-22, #1958 vs #1960): charter said "#1960 ToString
regression, run 27988140835". Reality: that run's branch was `pr-1958` and it
failed `check for test262 regressions` (js-host, 24 assertion_fail, eval-code
cluster) — that's **#1958's** regression. #1960 had its **own** earlier run
27987896648 (branch `pr-1960`) failing `merge shard reports` → the **standalone
floor** gate (#1897/#2097, merge_group-only), net -23, 21 compile_error on
String/S9.8.1 ToString + Number/S9.3.1 + RegExp source tests. Two independent
real regressions in two lanes — both `hold` correct.

How to get the per-file regressed list (the summary artifact only has the bucket
signature + category counts, NOT file paths):
1. `gh api .../actions/runs/<runid>/jobs?per_page=100` (paginate; `gh run view`
   truncates at 30 jobs) → find the failed job (`merge shard reports` or
   `check for test262 regressions`).
2. Download the run's `test262-merged-report` artifact (has both
   `test262-results-merged.jsonl` js-host and `test262-standalone-results-merged.jsonl`).
3. Fetch the matching baseline: `node scripts/fetch-baseline-jsonl.mjs`
   (js-host) or `--standalone`. Diff base `pass` vs new `!= pass` keyed on the
   `.file` field.

Match the regressed cluster to the PR's changed files to confirm causation
(emitToString/string-ops → String/Number ToString; pipeline driver
compiler.ts/index.ts → eval-code routing). See [[project_standalone_floor_only_on_merge_group]].
