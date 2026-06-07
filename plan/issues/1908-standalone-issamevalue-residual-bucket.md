---
id: 1908
title: "standalone: re-split and fix residual isSameValue bucket after #1776/#1807"
status: in-review
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, testing
language_feature: equality, test262-harness
goal: standalone-mode
related: [1776, 1807, 1623]
test262_bucket: issamevalue-invalid-wasm
test262_count: 0
claimed_by: codex-developer
claimed_at: 2026-06-07T02:14:53.647Z
pr: 1257
---

# #1908 — Residual standalone `isSameValue` bucket

## Problem

The checked standalone report still assigns `5,556` failures to
`issamevalue-invalid-wasm`, even though the earlier focused owners are marked
done:

- `#1776` fixed the original externref invalid-Wasm case.
- `#1807` fixed the async-generator index-shift residual.

The bucket now needs a fresh split against the current report instead of
continuing to point only at completed issues.

## Scope

- Reproduce representative failures from the current standalone report.
- Determine whether the bucket is still invalid Wasm in `isSameValue`, a
  classifier over-match on assertion failures, or a new equality helper bug.
- If it is classifier drift, update `scripts/build-test262-report.mjs` so the
  failures move to their real owners.
- If it is a codegen bug, fix the smallest helper/emitter path and add a focused
  regression test.

## Acceptance Criteria

- The issue documents the current dominant signatures/files for the bucket.
- Either the `issameValue` invalid-Wasm count materially drops on a rebuilt
  standalone report, or the remaining failures are reclassified to more precise
  issues.
- Any code fix has a focused `tests/issue-1908.test.ts` regression.

## Findings — 2026-06-07

The residual bucket was classifier drift, not a new `isSameValue` codegen bug.
The checked standalone report's `issamevalue-invalid-wasm` bucket had `5,556`
rows, but `5,550` were `assertion_fail`, `2` were `unreachable`, `1` was
`runtime_error`, and `3` were `promise_error`; there were no `wasm_compile`
rows in the bucket. The dominant signatures were ordinary assertion locations:

- `assert.sameValue(C[''], 'get string')`
- `assert.sameValue(x, #)`
- `assert.sameValue(c['#'](), '#')`
- `assert.sameValue(result.done, false, 'First result done flag')`
- `assert.sameValue(c[# + # - # * # / # ** #](), #)`

Representative files were class/computed-name and generator assertion tests:

- `test/language/statements/class/accessor-name-static/literal-string-empty.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/statements/class/cpn-class-decl-computed-property-name-from-string-literal.js`
- `test/language/statements/class/definition/methods-gen-yield-as-generator-method-binding-identifier.js`
- `test/language/statements/class/cpn-class-decl-fields-methods-computed-property-name-from-math.js`

Fix: narrowed `issamevalue-invalid-wasm` in `scripts/build-test262-report.mjs`
to actual Wasm validator failures naming the `isSameValue` helper, e.g.
`Compiling function #N:"isSameValue" failed: ... expected type ...`. Plain
`assert.sameValue(...)` assertion failures now fall through to the real
feature buckets.

Validation rebuild:

```bash
node scripts/build-test262-report.mjs \
  --input .test262-cache/test262-standalone-current.jsonl \
  --output public/benchmarks/results/test262-standalone-report.json \
  --target standalone \
  --include-proposals \
  --baseline-sha e6eedd6821a281063fc28e768431a09cfa98f340 \
  --baseline-generated-at 2026-06-06T19:01:40Z \
  --max-unclassified-root-causes 0
```

Result: `issamevalue-invalid-wasm` is absent from the rebuilt checked report
(`0` rows, down from `5,556`), `root_cause_map.classified` remains `30,733`,
and `root_cause_map.unclassified.count` remains `0`. The former samples now
land in more precise buckets, including:

- `class-prototype-private-descriptor`: `3,226` -> `4,723`
- `standalone-iterator-protocol`: `2,514` -> `4,247`
- `standalone-dynamic-object-property`: `8,163` -> `8,892`

Focused regression: `tests/issue-1908.test.ts` pins both sides of the split:
a real `isSameValue` validator failure remains in `issamevalue-invalid-wasm`,
while a class `assert.sameValue(...)` assertion failure reclassifies to
`class-prototype-private-descriptor`.

## Revalidation — 2026-06-07

- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- Rebuilt the standalone report from
  `.test262-cache/test262-standalone-current.jsonl` against current
  `origin/main` (`9c25e310c4b31caa4f502cfbceb975016fb50663`); the
  `issamevalue-invalid-wasm` bucket remained absent, classified stayed
  `30,733`, and unclassified stayed `0`.

## Revalidation After Main Merge — 2026-06-07

- Merged current `origin/main`
  (`5bef49a5abaae3e0ae65d41cfda6844d06197d06`) into `symphony/1908` and
  resolved the report-builder conflict by keeping both the #1908
  `isSameValue` validator matcher and main's #1910 `ToPrimitive` matcher.
- Rebuilt `public/benchmarks/results/test262-standalone-report.json` from the
  current `loopdive/js2wasm-baselines` `test262-standalone-current.jsonl`
  snapshot cached as `.test262-cache/test262-standalone-current-main.jsonl`;
  `issamevalue-invalid-wasm` drops from the current main report's `5,567`
  rows to `0`, `root_cause_map.classified` is `30,688`, and
  `root_cause_map.unclassified.count` is `0`.
- `pnpm exec vitest run tests/issue-1908.test.ts tests/issue-1910.test.ts`
  passed.

## Final Revalidation — 2026-06-07

- Merged current `origin/main`
  (`3827daa96e6b7147a30474c85a065e8b35bafed2`) into `symphony/1908` before
  republishing PR #1257.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
