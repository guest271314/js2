---
id: 1807
title: "standalone: 277 async-generator tests emit invalid Wasm in isSameValue (#1776 residual)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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
