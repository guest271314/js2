---
id: 1776
title: "standalone test262 isSameValue emits invalid Wasm for externref operands"
status: done
created: 2026-06-01
updated: 2026-06-02
completed: 2026-06-01
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, testing
language_feature: equality
goal: standalone-mode
sprint: 58
owner: Tesla
related: [1228, 1472]
---
# #1776 - standalone test262 isSameValue emits invalid Wasm for externref operands

## Problem

The standalone test262 run has a broad invalid-Wasm cluster inside the harness
helper `isSameValue`. The helper is compiled with `externref` parameters, but
the generated comparison path feeds those locals into call sites that expect
numeric or boolean Wasm values (`f64` / `i32`). The module then fails validation
before the actual test body can run.

This is especially expensive because `isSameValue` is a core test262 helper:
the invalid harness masks unrelated feature results across many categories.

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). The `isSameValue` invalid-Wasm externref
typing cluster accounts for 13,614 failures in this run.

Representative error signature:

```text
invalid Wasm binary (WebAssembly.instantiate(): Compiling function ...:"isSameValue" failed: call[0] expected type f64, found local.get of type externref ...)
```

The same cluster also appears with `expected type i32, found local.get of type
externref`.

## Likely root cause

`isSameValue(actual, expected)` accepts untyped test262 harness values, so the
compiled function uses `externref` parameters. The equality/SameValue lowering
or helper-call selection then takes a numeric/boolean path without first proving
or converting the operand type. In JS-host mode, dynamic equality can delegate
through host semantics; standalone needs a Wasm-native dynamic equality path or
a clean compile-time fallback instead of emitting ill-typed calls.

Likely implementation shape:

- Detect `externref`/unknown operands in strict equality and SameValue-style
  helper lowering.
- Route them to a standalone-safe dynamic equality helper that performs tag
  checks, numeric unboxing only after proof/cast, string equality, null/undefined
  handling, and reference identity where representable.
- If a required dynamic case is not yet supported in standalone, emit a clear
  compile error rather than invalid Wasm.

## Affected features/categories

- test262 harness helper `isSameValue`
- strict equality / SameValue-style comparison on `any` or `externref`
- broad test262 categories that import the harness helper, including
  `built-ins`, `language`, and Annex B tests
- standalone-mode result quality, because the harness failure masks real
  feature-specific pass/fail outcomes

## Acceptance criteria

- [ ] The representative `isSameValue` failures validate in standalone mode or
      fail with a clear compile-time diagnostic; no invalid Wasm is emitted.
- [ ] `externref` operands are never passed directly to helper calls expecting
      `f64` or `i32`.
- [ ] A focused regression test covers `isSameValue`-shaped equality with
      `externref`/unknown parameters under `--target standalone`.
- [ ] The standalone test262 artifact no longer contains the signature
      `isSameValue" failed: call[0] expected type f64, found local.get of type externref`
      or the `expected type i32` variant.

## Likely files/subsystems

- equality and comparison lowering in `src/codegen/expressions/*`
- type coercion helpers in `src/codegen/type-coercion.ts`
- standalone dynamic-value helpers used for `externref` / `any` comparisons
- test262 harness compilation path and focused standalone tests

## Narrow standalone verification

After the fix, rerun a small standalone test262 slice containing
`isSameValue`-heavy tests, then check the artifact:

```bash
rg -c 'isSameValue.*expected type (f64|i32), found local\.get of type externref' benchmarks/results/test262-standalone-results-*.jsonl
```

The count should be `0` for the new standalone artifact.

## Implementation notes - 2026-06-01

Spec check: TC39 ECMA-262 §7.2.9 SameValue says to return false when
`SameType(x, y)` is false, use `Number::sameValue` only when `x` is a Number,
and otherwise use `SameValueNonNumber`. The invalid Wasm was not a SameValue
algorithm edge case directly; it was a codegen integrity bug in the dynamic
externref strict-equality fallback used by the test262-shaped helper.

Finding: the externref equality fallback called `ensureLateImport("__host_eq")`
or `ensureLateImport("__host_loose_eq")`, then ran `flushLateImportShifts`, but
the nested fallback instruction array still emitted the pre-flush function
index. In the standalone `isSameValue(a: any, b: any)` repro that stale index
became `call 0`, whose signature expected `f64`, while the stack held
`externref` locals. V8 therefore rejected the module with:

```text
Compiling function ...:"isSameValue" failed: call[0] expected type f64, found local.get of type externref
```

Fix: after late-import flushing, look up the final function indices before
emitting calls to `__host_eq`, `__host_loose_eq`, `__typeof_number`, and
`__unbox_number`. This keeps the existing dynamic equality behavior but stops
externref operands from being sent to unrelated numeric helper signatures.

Regression: added `tests/issue-1776.test.ts`, which compiles a
test262-shaped `isSameValue`/`assert_sameValue` helper under
`target: "standalone"` and forces `WebAssembly.compile` so validation failures
surface in the focused test.

Validation:

```bash
pnpm exec vitest run tests/issue-1776.test.ts
pnpm exec vitest run tests/issue-1471.test.ts tests/issue-1157.test.ts
```

Both scoped runs passed locally.

## Completion - PR #1025

Closed by merged PR [#1025](https://github.com/loopdive/js2/pull/1025), which refreshed the late-import call indices for externref equality fallbacks and added the focused standalone regression coverage above.
