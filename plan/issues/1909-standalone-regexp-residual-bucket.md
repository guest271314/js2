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
pr: 1260
claimed_by: codex-developer
claimed_at: 2026-06-07T02:21:53.739Z
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

Publish blocker:

- PR #1260 is already queued to merge at remote head `d0cbff27c`, so GitHub
  rejected a later push with `GH006: Protected branch update failed` because
  queued PR branches cannot be updated without dequeueing the PR.
- Local post-queue commits merge `origin/main` at `ff02d2011` and record the
  final validation above, but they are not published while the PR remains
  queued.
