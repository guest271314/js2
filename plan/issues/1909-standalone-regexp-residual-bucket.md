---
id: 1909
title: "standalone RegExp residual bucket after #1474/#682: split Phase 2d and native-engine gaps"
status: in-progress
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [682, 1474, 1539]
test262_bucket: standalone-regexp
test262_count: 1997
pr: 1289
claimed_by: codex-developer
claimed_at: 2026-06-07T06:49:05.075Z
---

# #1909 — Standalone RegExp residual bucket

## Problem

The standalone report still has `1,997` failures in `standalone-regexp` even
though the original native-RegExp umbrellas are marked done. Current samples
include unsupported flags and pattern forms such as `u`/`v`/`d`, lookahead,
negated shorthand inside character classes, and word-boundary variants.

## Scope

- Re-split the current RegExp bucket by signature and feature family.
- Land the smallest high-count native-engine slice if one is clearly ready
  (for example a contained flag/pattern form).
- Otherwise file child issues from the split and update the classifier so the
  dashboard stops pointing only at completed umbrellas.

## Acceptance Criteria

- `tests/issue-1909.test.ts` covers at least one newly-supported standalone
  RegExp residual or a classifier regression if this issue is analysis-only.
- The issue records the top current RegExp signatures and which child issue owns
  each.
- A rebuilt standalone report no longer treats the entire residual as only
  `#682/#1474`.

## 2026-06-07 implementation findings

This issue was handled as a classifier/split slice, not a compiler semantics
slice. I fetched the published standalone JSONL from
`loopdive/js2wasm-baselines`:

- Source:
  `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl`
- Rebuild command:
  `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909.json --target standalone --include-proposals --max-unclassified-root-causes 0`
- Root-cause map remained complete: `30,733 / 30,733` non-pass/non-skip rows
  classified, `0` unclassified.

The previous single `standalone-regexp` bucket had `1,997` rows:

- `1,730` compile errors
- `267` fail/runtime rows
- error categories: `other` 1,709, `assertion_fail` 206, `runtime_error` 37,
  `null_deref` 23, `wasm_compile` 16, `illegal_cast` 5, `oob` 1

After this change, the rebuilt report splits those same `1,997` rows:

| Count | Bucket                              | Owner                | Representative signatures                                                                                            |
| ----: | ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
|   833 | `standalone-regexp-phase-2d`        | #1911                | `flags "u"`, `flags "v"`, lookahead/lookbehind, regexp modifiers, Unicode/property escapes                           |
|   104 | `standalone-regexp-phase-2b`        | #1912                | word-boundary `\b`/`\B`, backreferences, negated shorthand in classes, class range compatibility                     |
|   452 | `standalone-regexp-string-protocol` | #1913                | `@@match`, `@@matchAll`, `@@replace`, `@@split`, `lastIndex`, split limit, replacement substitutions                 |
|   546 | `standalone-regexp-native-engine`   | #1914                | `pattern.source`, result `input/index`, `RegExp.prototype` descriptors, dynamic constructor/reflection/object access |
|    62 | `standalone-regexp` fallback        | #1909 + child issues | duplicate flags, syntax refusals, generic String.search/Reflect residuals needing later reassignment                 |

Implementation:

- Added ordered RegExp sub-buckets to `scripts/build-test262-report.mjs` ahead
  of the generic RegExp fallback.
- Filed child issues #1911, #1912, #1913, and #1914 for the current owners.
- Added `tests/issue-1909.test.ts` to lock representative classifier routing.
- Updated the older #1781 root-cause smoke test to expect the new
  native-engine sub-bucket for assertion/runtime RegExp rows.
- Before publishing, trimmed the PR net diff back to this issue's classifier,
  test, and RegExp child-issue files after syncing with current `origin/main`.

Validation:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

Final publish check after merging `origin/main` on 2026-06-07:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

The final rebuilt report keeps `30,733 / 30,733` standalone non-pass/non-skip
rows classified with `0` unclassified. The RegExp residual remains split into
`833` Phase 2d rows, `104` Phase 2b rows, `452` string-protocol rows, `546`
native-engine rows, and `62` fallback rows.

## 2026-06-07 PR status refresh

PR #1260 is open, ready for review, and still points at this issue branch. The
previous queue push blocker cleared after GitHub dropped the temporary merge
queue refs, but the remote PR head `a3fe42c32` now shows a failed
`check for test262 regressions` job:

- run: `https://github.com/loopdive/js2/actions/runs/27080559423/job/79926321031`
- summary: `62` pass-to-other transitions, `27` improvements, net `-35` pass
- baseline note in the failed log: baseline age `1h 20m` at commit `99b58e6`

The branch was then resynced with current `origin/main`, and the scoped local
validation listed above passed again.

## 2026-06-07 publish blocker after main sync

The final branch push was rejected because PR #1260 is back in GitHub's merge
queue:

- Remote PR head: `a3fe42c32`
- Local attempted head: `0808e70fc`
- Queue ref observed:
  `refs/heads/gh-readonly-queue/main/pr-1260-f4dd784d4f1960a8c759b51f0cff23e8f4ed4f34`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the current main-sync metadata can be pushed.

## 2026-06-07 queue refresh after reassignment

Scoped validation was rerun in this worktree after the reassignment:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. At refresh time, PR #1260 remained open and ready,
with remote head `a3fe42c32`. GitHub had accepted it into the merge queue
again:

- Queue ref:
  `refs/heads/gh-readonly-queue/main/pr-1260-f4dd784d4f1960a8c759b51f0cff23e8f4ed4f34`
- Merge-group run:
  `https://github.com/loopdive/js2/actions/runs/27081078870`
- Current merge-group status at refresh time: `in_progress`

At that point the local branch still contained post-sync metadata commits that
could not be pushed while GitHub kept the PR branch in the merge queue.

## 2026-06-07 merged PR state

PR #1260 merged via the GitHub merge queue at `2026-06-07T03:16:41Z`:

- Merge commit: `d4492156fbb45e50954700f8c1f3ca6b6e3970ef`
- PR URL: `https://github.com/loopdive/js2/pull/1260`
- Final PR head included in the merge: `a3fe42c32`

After the merge, this branch was merged with current `origin/main` so the local
issue metadata is based on the merged PR state. The issue remains `in-review`
with `pr: 1260`; the PR-status poller owns the eventual `done` transition.

## 2026-06-07 follow-up metadata refresh

This issue was reassigned after PR #1260 had already merged. Current GitHub
state confirms PR #1260 is `MERGED`, ready/non-draft, with merge commit
`d4492156fbb45e50954700f8c1f3ca6b6e3970ef`.

The implementation remains complete and present on `origin/main`; this branch is
now carrying only the #1909 issue-state refresh so the plan metadata stays in
sync with the merged PR state.

Follow-up validation after merging current `origin/main`:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

The rebuilt report still classifies `30,733 / 30,733` standalone non-pass
non-skip rows. The RegExp split is unchanged: `833` Phase 2d rows, `104` Phase
2b rows, `452` string-protocol rows, `546` native-engine rows, and `62`
fallback rows.

Opened ready follow-up PR #1289 for this issue-state refresh.

## 2026-06-07 final PR refresh

Current GitHub state for PR #1289:

- URL: `https://github.com/loopdive/js2/pull/1289`
- State: open, ready/non-draft
- Head: `symphony/1909` at `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Merge state: `CLEAN`
- Checks: all reported PR checks succeeded

The issue remains `in-review` with `pr: 1289`; the PR-status poller owns the
eventual `done` transition after merge.

## 2026-06-07 queue push blocker

After the final PR refresh commit, the branch push was rejected because GitHub
has already added PR #1289 to the merge queue:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `83c265ff0`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the latest metadata refresh can be pushed.
