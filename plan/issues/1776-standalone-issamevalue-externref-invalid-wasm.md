---
id: 1776
title: "standalone test262 isSameValue emits invalid Wasm for externref operands"
status: done
created: 2026-06-01
updated: 2026-06-03
completed: 2026-06-03
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

## Reopened evidence - refreshed standalone artifact 2026-06-02

The latest published standalone baseline still contains this root cause after
PR #1025 landed. Source:
`loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The root-cause classifier assigns **1,436** bad rows primarily to this issue.
A raw non-exclusive search for `isSameValue` validator failures finds **1,469**
rows, because a small number also match earlier classifier buckets.

Representative residual signatures:

```text
Compiling function #47:"isSameValue" failed: call[0] expected type i32,
found local.get of type externref
```

```text
Compiling function #70:"isSameValue" failed: f64.eq[0] expected type f64,
found call of type i32
```

Example files:

- `test/language/statements/async-generator/dflt-params-ref-self.js`
- `test/language/statements/async-generator/dstr/dflt-ary-ptrn-rest-id.js`
- `test/language/statements/class/elements/after-same-line-static-async-gen-rs-static-method-privatename-identifier.js`
- `test/language/statements/class/subclass/derived-class-return-override-catch-finally-arrow.js`

Interpretation: PR #1025 fixed the late-import index path captured by the
focused unit test, but it did not retire the broader standalone SameValue /
dynamic equality typing bug in the test262 harness. Keep this issue open until
the standalone artifact has zero `isSameValue` validator failures, including
the `f64.eq ... found call of type i32` variant.

## Completion - 2026-06-03 (residual fix)

Root cause of the residual 1,436 rows: the externref dynamic-equality fallback
in `src/codegen/binary-ops.ts` delegated to the JS-host imports `__host_eq` /
`__host_loose_eq` even under `--target standalone` / `--target wasi`. Neither
helper has a Wasm-native implementation, so:

1. an unsatisfiable `env::__host_eq` import leaked into the standalone module —
   `WebAssembly.instantiate(module, {})` failed with
   `Import #0 "env": module is not an object or function`; and
2. the lazily-built numeric fallback referenced helper indices that, combined
   with the late-import shift, produced the
   `f64.eq[0] expected type f64, found call of type i32` and
   `call[0] expected type i32, found local.get of type externref` validator
   signatures.

The test262 harness helper `isSameValue(a: any, b: any)` compiles both params
to `externref`, so every `a === b` / `a !== a` in it took this path — masking
the whole harness for the affected categories.

Fix: in no-JS-host mode (`ctx.standalone` / `ctx.wasi`), lower externref
`===`/`!==` to a self-contained Wasm-native tag dispatch on the two boxed
operands — both typeof number → unbox f64 + compare (recovers equal numbers in
distinct boxes AND makes NaN self-comparison work), both typeof boolean →
unbox i32 + compare, otherwise reference identity via
`any.convert_extern` + `ref.test`/`ref.eq` on the WasmGC `eq` heap type
(non-eqref or tag-mismatch → unequal, per §7.2.16). No host import; no externref
is ever fed into an f64/i32 helper signature. The JS-host path is untouched.

Regression coverage: `tests/issue-1776.test.ts` now asserts (a) zero leaked
`env::*` imports + successful `WebAssembly.instantiate(binary, {})` in standalone,
(b) correct isSameValue results for number / NaN / +0 / boolean, (c) object
reference identity preserved, (d) the `f64.eq`/`!==` variant validates, (e) the
wasi target also has no host-eq leak, and (f) JS-host equality is unchanged.

Validation:

```bash
pnpm exec vitest run tests/issue-1776.test.ts          # 6 pass
pnpm exec vitest run tests/equivalence/strict-equality-edge-cases.test.ts \
  tests/equivalence/loose-equality.test.ts \
  tests/equivalence/equality-mixed-types.test.ts \
  tests/equivalence/comparison-coercion.test.ts        # 65 pass, no regressions
```
