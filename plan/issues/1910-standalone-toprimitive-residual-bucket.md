---
id: 1910
title: "standalone ToPrimitive residual bucket after #1900/#1525b"
status: in-review
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: to-primitive, abstract-operations
goal: standalone-mode
related: [1806, 1900, 1525, 1525b, 1759]
test262_bucket: object-to-primitive
test262_count: 784
claimed_by: codex-developer
claimed_at: 2026-06-07T03:13:23.989Z
pr: 1265
---

# #1910 — Standalone ToPrimitive residual bucket

## Problem

The current standalone report still assigns `1,237` failures to
`object-to-primitive`, but the historical owners are mostly done or in-review:

- `#1806` / `#1900` covered standalone native ToPrimitive slices.
- `#1525` is done.
- `#1525b` is in review for method trampoline / step-6 residuals.
- `#1759` is done and was WASI number-string specific.

This bucket needs a current split so remaining failures are no longer hidden
behind completed umbrella records.

## Scope

- Rebuild or inspect the latest standalone JSONL for top ToPrimitive signatures.
- Separate real native ToPrimitive gaps from template/string/RegExp/Date
  coercion and classifier over-matches.
- Fix one contained residual if obvious; otherwise file child issues and update
  the classifier.

## Acceptance Criteria

- The issue records current top files/signatures for the `object-to-primitive`
  bucket.
- A focused regression test is added for any fixed residual.
- The report classifier points the remaining bucket at current follow-up issues
  instead of only completed historical owners.

## Findings - 2026-06-07

Source inspected: `loopdive/js2wasm-baselines` `main`
`48f57c393b69e8ad146833cd76476b030345f24d`,
`test262-standalone-current.jsonl` (48,114 rows). The published standalone
report metadata is `baseline_sha: e6eedd6821a281063fc28e768431a09cfa98f340`
and `baseline_generated_at: 2026-06-06T19:01:40Z`.

The old broad text classifier assigned **1,237** rows to
`object-to-primitive`. After excluding path-specific overmatches, the real
generic residual bucket is **784** rows:

- Status split: 636 `fail`, 148 `compile_error`.
- Error categories: 770 `runtime_error`, 8 `wasm_compile`, 6
  `assertion_fail`.
- Top path clusters:
  - `test/language/expressions/compound-assignment` — 131
  - `test/language/statements/function` — 41
  - `test/language/statements/try` — 23
  - `test/language/expressions/call` — 19
  - `test/language/expressions/equals` — 19
  - `test/language/expressions/addition` — 17
  - `test/language/expressions/does-not-equals` — 16
  - `test/language/expressions/assignment` — 15
  - `test/language/expressions/left-shift` — 15
  - `test/language/expressions/unsigned-right-shift` — 14
- Top signatures:
  - 630x `runtime_error:L#:## Cannot convert object to primitive value`
  - 140x `runtime_error:Cannot convert object to primitive value`
  - 8x invalid Wasm in `__call_@@toPrimitive` fallthrough
    (`expected externref, got (ref #)`)
  - 6x assertion tails around `Error` / `EvalError` message
    ToPrimitive and object spread key `toString` ordering.

The 453 rows split out of the old bucket now route to existing, more specific
follow-up buckets:

- 166 -> `string-methods-coercion` (`#1470`, `#1105`, `#1442`, `#1381`);
  includes `String.*` and URI built-ins (`decodeURI`, `encodeURIComponent`,
  etc.) that consume ToString.
- 122 -> `function-object-semantics` (`#731`, `#1732`, `#1596`).
- 73 -> `object-property-semantics` (`#1905`, `#1906`, `#1629`, `#1472`).
- 61 -> `array-typedarray-buffer` (`#1358`, `#1461`, `#1654`).
- 12 -> `symbol-builtin-semantics` (`#483`, `#487`, `#1564`).
- 6 -> `bigint-typed-path` (`#1644`, `#1535`).
- 6 -> `number-parsing-formatting` (`#1335`, `#1663`, `#1689`).
- 5 -> `date-formatting-coercion` (`#1343`).
- 2 -> `template-literals` (`#1759`, `#836`).

## Implementation - 2026-06-07

- Added `isObjectToPrimitiveResidual()` in
  `scripts/build-test262-report.mjs` so the generic bucket no longer captures
  path-specific string/URI, RegExp, Date, template, Symbol, BigInt,
  TypedArray/ArrayBuffer, Object built-in, Function, Math, and Number
  residuals solely because the error text mentions `valueOf` / `toString` /
  ToPrimitive.
- Updated the remaining generic bucket owners to `#1910`, `#1525b`, `#1900`,
  and `#1472`, rather than the completed-only historical umbrella set.
- Expanded the standalone string bucket to cover URI built-ins and `#1470`.
- Moved template literal classification ahead of the broad `object-` path
  rule so `template-object-*` tests are not misclassified as object-property
  failures.
- Regenerated `public/benchmarks/results/test262-standalone-report.json` and
  `website/public/benchmarks/results/test262-standalone-report.json`.
- Added focused classifier coverage in `tests/issue-1910.test.ts`.

No contained compiler semantics residual was obvious from this pass; this PR
is the classifier/reporting split requested by the issue.

Implementation landed in PR #1258; PR #1265 publishes the final issue-record
validation after syncing the assigned branch with current `origin/main`.

## Validation - 2026-06-07

- `npm test -- tests/issue-1910.test.ts` (2 tests passed).
- After merging current `origin/main` (`5bef49a5a`):
  - `npm test -- tests/issue-1910.test.ts tests/build-test262-report.test.ts`
    (8 tests passed).
  - `npx prettier --check` on the touched script, test, and issue files
    (passed).
- After merging current `origin/main` (`3827daa96`):
  - `npm test -- tests/issue-1910.test.ts tests/build-test262-report.test.ts`
    (8 tests passed).
  - `npx prettier --check` on the touched script, test, and issue files
    (passed).
- After merging current `origin/main` (`ff02d2011`):
  - `npm test -- tests/issue-1910.test.ts tests/build-test262-report.test.ts`
    (8 tests passed).
  - `npx prettier --check` on the issue file (passed).
- After merging current `origin/main` (`f4dd784d4`):
  - `npm test -- tests/issue-1910.test.ts tests/build-test262-report.test.ts`
    (8 tests passed).
  - `npx prettier --check` on the issue file (passed).
