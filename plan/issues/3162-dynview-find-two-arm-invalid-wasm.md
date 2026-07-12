---
id: 3162
title: "[SOUNDNESS] dyn-view find/findIndex through the #3058 two-arm emits INVALID wasm (fallthru type i32 vs ref) on a mutating predicate"
status: ready
sprint: current
created: 2026-07-12
priority: high
task_type: bug
feasibility: medium
area: codegen
goal: standalone
language_feature: typed-arrays, array-methods
test262_category: built-ins/TypedArray/prototype/find
related: [2872, 3058]
parent: 2872
---

# #3162 — dyn-view `find`/`findIndex` two-arm emits INVALID wasm

## Severity: codegen soundness (higher than a CE or a feature gap)

This is **not** a missing-feature gap and **not** a leaked-host-import CE — it is
the compiler emitting a **structurally invalid wasm module** (fails
`WebAssembly.compile`/`instantiate` validation), i.e. a codegen-soundness bug.
Whoever picks it up should treat it as an emitter type-unification fix, not a
feature addition.

## Currently LATENT (why it isn't biting main today)

The bug only manifests when `find`/`findIndex` are members of
`DYN_VIEW_READ_METHODS` (`src/codegen/array-methods.ts`) — i.e. routed through
the #3058 dyn-view two-arm (`emitDynViewMethodTwoArm`). #2872 slice 4
deliberately **excluded** `find`/`findIndex` from that set for exactly this
reason, so main is unaffected. This issue tracks the soundness fix that must
land **before** `find`/`findIndex` (a measured **+13 fail→pass**) can be
lit up.

## Repro

Add `"find"` (and/or `"findIndex"`) to `DYN_VIEW_READ_METHODS`, then compile the
harness shape standalone:

```ts
export function test(): number {
  function run(TA: any): number {
    const a: any = new TA([1, 2, 3]);
    // a mutating predicate is the trigger (test262 predicate-call-changes-value)
    return a.find(function (v: any, i: any, arr: any) { arr[0] = 9; return v === 2; }) === 2 ? 1 : 0;
  }
  return run(Int8Array);
}
```

test262 file: `built-ins/TypedArray/prototype/find/predicate-call-changes-value.js`
(+ the `findIndex` twin, + the `BigInt/` variants).

**Observed** (real runner, `--target standalone`):

```
compile_error: WebAssembly.instantiate(): Compiling function #218:"__closure_5"
failed: type error in fallthru[0] (expected (ref null 4), got i32) @+67789
```

Measured impact when the set includes find+findIndex: **+13 fail→pass but +4
fail→compile_error** — the CEs are these invalid-wasm modules.

## Root-cause hypothesis

The two-arm (`emitDynViewMethodTwoArm`, array-methods.ts) unifies its THEN arm
(the dyn-view-materialized-to-`$__vec_f64` `find` result) and ELSE arm to a
single `externref` branch result via `coerceArmToExternref`. On the
`predicate-call-changes-value` shape the materialized `find` impl over the
f64-vec leaves an **i32** on the stack where the branch fallthrough expects a
`(ref null …)` — the arm result ValType is not being coerced before the
`if`-block's fallthrough. The "expected (ref null 4)" (not `externref`) in the
error suggests the mismatch is between the materialized-vec element ref type and
the branch type, i.e. `find`'s returned ValType for this shape is not the
`externref` `coerceArmToExternref` assumes. Likely the mutating-predicate path
takes a different `find` codegen branch (a closure-capture / re-entrancy arm)
whose result ValType the two-arm doesn't coerce.

Investigate: what ValType does `compileArrayMethodCall(... "find" ..., skipDynViewWrap=true)`
return over an `$__vec_f64` for the mutating-predicate shape, and why
`coerceArmToExternref` leaves it as i32. The fix is almost certainly in the
arm-result coercion / the `find` impl's returned ValType, NOT per-method.

## Acceptance

- With `find`/`findIndex` in `DYN_VIEW_READ_METHODS`, the repro + the four
  `find`/`findIndex` `predicate-call-changes-value{,BigInt}` test262 files
  compile to VALID wasm (no fallthru type error).
- Net for `find`+`findIndex` dyn-view lane: the +13 fail→pass lands with **zero
  fail→CE**.
- `prove-emit-identity` IDENTICAL (gc/wasi/standalone corpus byte-inert — the
  change is dyn-view-two-arm-only).
- No regressions in the broader standalone stride.

## Not in scope (separate #2872 cluster-tracker notes, lower severity)

- `findLast`/`findLastIndex`: missing `__call_1_f64` registration on this path
  (a CE, not invalid wasm) — likely a shared dispatch-arm addition.
- `every`/`some`/`forEach`: detached-buffer regressions (materialization
  snapshots before a mid-callback detach) — a semantics gap, not soundness.
- `map`/`filter`/`sort`/`with`: need a TA-result builder.
