---
id: 1807
title: "standalone: 277 async-generator tests emit invalid Wasm in isSameValue (#1776 residual)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: async-generators, equality, isSameValue
goal: standalone-mode
sprint: 59
related: [1776, 1623, 1665, 1472]
---
# #1807 — Standalone isSameValue Wasm type mismatch for async-generator params

## Symptom

**277 standalone-lane tests** fail at compile time with:

```
invalid Wasm binary (WebAssembly.instantiate(): Compiling function #N:"isSameValue" 
  failed: call[0] expected type ...)
```

**Baseline**: sha `f692249d`, 2026-06-03T22:28Z.

## Sample test files

```
test/language/statements/async-generator/dflt-params-ref-self.js
test/language/statements/async-generator/dstr/dflt-ary-ptrn-rest-id.js
test/language/statements/async-generator/dstr/obj-ptrn-prop-ary-trailing-comma.js
```

All samples are in `language/statements/async-generator/`. The function
`isSameValue` is the test262 harness helper (compiled inline by the runner):

```js
function isSameValue(a, b) {
  if (a === 0 && b === 0) return 1 / a === 1 / b;
  if (a !== a && b !== b) return true;
  return a === b;
}
```

## Root cause

`#1776` fixed the case where `isSameValue`'s operands were `externref` —
the `a === 0` path produced `f64.ne externref externref` which is invalid Wasm.

For **async-generator** tests, the operands have a different type — likely
the generator's internal state `ref $AsyncGenState` or similar struct ref.
`isSameValue` compiled for the async-generator context calls the strict-equals
helper with a struct ref argument, but the helper is typed for `externref`,
producing a `call` type mismatch.

This is a RESIDUAL not covered by #1776 (which fixed externref-only).

## Fix approach

The `isSameValue` helper in the test runner needs to be compiled with a
polymorphic signature, or the strict-equals logic needs to guard on the
operand type when compiling for standalone:

1. **Detect the call site type**: when emitting `isSameValue`'s internal `===`
   comparison, check if both operands have a non-externref ref type (e.g.
   `ref $AsyncGenState`). If so, emit a `ref.eq` or cast to `anyref` first.
   
2. **Widen to anyref at call sites**: before calling into `isSameValue` when
   operands are struct refs, emit `ref.as_non_null` + `any.convert_extern` or
   similar widening so the call types match.

3. **Preferred: introduce `__isSameValue` as a polymorphic helper** (declared
   `(func (param anyref anyref) (result i32))`) so all operand types can be
   passed uniformly after `extern.convert_any` / `any.convert_extern`.

## Acceptance criteria

- All 277 async-generator tests that currently fail with `isSameValue call[0]
  type mismatch` compile and instantiate without errors.
- #1776's fixed externref cases remain passing.
- No regressions in other categories.

## Root cause — 2026-06-04

The original hypothesis (polymorphic operand types) was wrong. The operands ARE
`externref` and take the correct #1776 Wasm-native tag-dispatch path. The real
defect is a **funcMap index over-shift of the union helpers** during finalize,
specific to modules that register host imports between two helper-emission
points.

Codegen layout in standalone/WASI is: function-table = `[imports …][defined
functions …]`. Two families of defined functions are emitted lazily during the
finalize phase:

1. **Native-string helpers** (`__str_*`) — `ensureNativeStringHelpers` snapshots
   `ctx.nativeStrHelperImportBase = ctx.numImportFuncs` at its first emission
   (here `numImportFuncs == 0`, before any host import). They bake sibling-call
   `call funcIdx` values relative to that base.
2. **Union helpers** (`__box_number`, `__typeof_number`, `__unbox_number`,
   `__typeof_boolean`, `__unbox_boolean`, …) — emitted later by
   `addUnionImportsAsNativeFuncs`, registered at `funcIdx = numImportFuncs +
   mod.functions.length` (the *current* import count).

Between (1) and (2), the async-generator path adds the `__make_callback` host
import (`collectCallbackImports` finalize), bumping `numImportFuncs` 0 → 1. So
the union helpers register at `numImportFuncs == 1` — their indices already bake
in that one import.

At finalize end, `reconcileNativeStrFinalizeShift` applies a **single uniform**
`added = numImportFuncs - base` delta to *every* defined function with a baked
`call funcIdx >= base`. With `base == 0` and 15 finalize imports, it shifts the
union helpers by +15 — but they only needed +14 (the `__make_callback` import
was already in their indices). Every `__typeof_*` / `__unbox_*` index in
`ctx.funcMap` ended up **+1 too high**.

`isSameValue`'s `externref` equality body reads those `funcMap` indices, so it
baked `call`s one slot too high. After `eliminateDeadImports` compacted the
index space (12 of the 17 generator imports are unused → pruned), the +1 error
surfaced as a stale call into the adjacent boxing helper:

```text
WebAssembly.instantiate(): Compiling function #46:"isSameValue" failed:
call[0] expected type i32, found local.get of type externref
```

`call <unbox_number_idx + 1>` lands on `__box_boolean (param i32)`, which wants
i32 while the stack holds the `externref` operand. (The `__typeof_*` off-by-ones
were silent because all `__typeof_*` share the `externref → i32` signature.)

## Fix — 2026-06-04

In `addUnionImportsAsNativeFuncs` (src/codegen/index.ts), **flush the pending
native-string finalize shift BEFORE registering the union helpers** when the
native-string regime is active and an import has drifted the count since the
base snapshot:

```ts
if (ctx.nativeStrHelperImportBase >= 0 && ctx.numImportFuncs > ctx.nativeStrHelperImportBase) {
  reconcileNativeStrFinalizeShift(ctx);
}
```

This advances `base` to the current `numImportFuncs` (absorbing the
`__make_callback` import into the native-string helpers immediately), so the
union helpers register at the SAME re-based `base`. The end-of-finalize
reconcile then applies one consistent delta to both groups: native-string
helpers get +1 (now) then +14 (end) = +15 (correct); union helpers get +14
(correct). No-op on the default GC path (`base` stays -1) and when no import
drifted the count.

## Test Results — 2026-06-04

- `tests/issue-1807.test.ts` (new, 3 tests) — async-generator + `assert.sameValue`
  shapes validate under `--target standalone`; `isSameValue` no longer emits a
  stale boxing-helper call.
- `tests/issue-1776.test.ts` — 6/6 pass (externref equality path unchanged).
- Equality equivalence suite (strict/loose/mixed/coercion) — 35/35 pass
  (JS-host path untouched).
- Standalone/native-string suites (#1470, #1588, #1321, #1335, #1597, #1666) —
  all pass; the one #1677 generator-for-of failure is a pre-existing `#681`
  iterator-protocol gate, reproduced identically on clean `origin/main`.
- Sampled 120 `language/statements/async-generator` test262 files compiled with
  `target: standalone`: **0** `isSameValue` validation failures (was the
  dominant cluster); 63 modules now fully validate. Remaining failures are
  unrelated async-generator feature gaps in function `f` (e.g. destructuring
  param lowering), out of scope for this issue.
