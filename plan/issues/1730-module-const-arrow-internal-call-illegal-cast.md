---
id: 1730
title: "internal call to a module-level `const` arrow traps with illegal cast"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: medium
task_type: bugfix
area: codegen
language_feature: closures, arrow-functions
goal: test262-conformance
related: [1727, 1115]
---

# #1730 — internal call to a module-level `const` arrow → "illegal cast"

## Problem

Calling a module-level `const`-bound arrow function from another function
(internal wasm `call_ref` dispatch, not the export boundary) traps at runtime
with `RuntimeError: illegal cast`. This is **independent of async** — a plain
synchronous arrow reproduces it:

```ts
const f = (x: number): number => x * 2;
export function main(): number { return f(21); }
// RuntimeError: illegal cast (expected 42)
```

The async variant traps identically:

```ts
const double = async (x: number): Promise<number> => x * 2;
export function main(): number { return double(21) as any as number; }
// RuntimeError: illegal cast (expected 42)
```

## Root cause (narrowed — dev, 2026-05-29)

NOT the #1727 Promise-wrap path. With the #1727 fix in place,
`asyncResultConsumedAsValue` correctly skips the wrap and the recorded
`callResult` ValType is `f64` — the value path is correct. The trap is at the
**closure dispatch site**: the `ref.cast` of the stored closure ref to its
specific wrapper struct type fails. The module-level `const` arrow is stored /
re-resolved in a way that the call-site `ref.cast` does not match (compare the
inline arrow / passed-as-arg paths, which work). Lives in `src/codegen/closures.ts`
closure call_ref dispatch (the `ref.cast typeIdx structTypeIdx` at the call
site, see closures.ts ~1699 / dispatch ref.cast), not in the async wrap.

## Further narrowing (senior-dev, 2026-05-30)

Reproduced the trap and bisected the two call shapes:

- **`f(21)` (direct call)** → TRAPS `illegal cast`.
- **`const g = f; g(21)` (via intermediate local)** → WORKS (returns 42).

The intermediate-local path loads the callee correctly:
`local.set $0 (extern.convert_any (global.get $global$0))` — `global$0` holds
the closure struct `(struct.new $0 (ref.func $__closure))`.

The direct-call path instead emits, inside the `call_ref` argument region, a
self re-resolution that **casts the wrong global**:
`ref.cast (ref null $0) (any.convert_extern (global.get $gimport$3))` where
`gimport$3` is the imported `"TypeError: Cannot access property…"` message
string global — the direct-call self-load grabs a garbage global instead of
`global$0`, then `ref.cast` to the closure struct type traps.

So the defect is in the **direct `Identifier(args)` dispatch for a
module-`const`-bound arrow** (`src/codegen/expressions/calls.ts`): the
closure-self/receiver load resolves the callee from the wrong global rather
than `ctx.moduleGlobals.get("f")` (`global$0`). The wrapper-types branch at
~7996 (`compileExpression(expr.expression)` → `any.convert_extern` →
`emitGuardedRefCast` → saved to a local) is the *correct* shape — the failing
path is a *different* arm that loads self from a sentinel.

## ROOT CAUSE (senior-dev, 2026-05-30) — late-import global-index shift misses the call_ref arg-block

Full `$main` dump of the failing case: the closure receiver `(local.get $0)`
IS correct (loaded from `global$0` earlier, the `throw (global.get $gimport$3)`
on the receiver null-check is also *correct* — gimport$3 is the legitimate
property-access-TypeError message). The trap is in the **call_ref's second
operand**, a `(block (result f64) …)` that RE-RESOLVES the callee to build the
funcref operand `$2`:

```wat
(call_ref $1
  (local.get $0)                       ;; receiver — correct
  (block (result f64)
    (local.set $scratch (f64.const 21))
    (global.set $global$3 (i32.const 1))
    (if (ref.is_null (local.tee $0
          (ref.cast (ref null $0)
            (any.convert_extern (global.get $gimport$3)))))   ;; ← STALE INDEX
      (then (throw $tag$0 (global.get $gimport$3))))
    (if (ref.is_null (local.tee $2 ( … struct.get $0 0 (local.get $0) … )))
      (then (throw $tag$0 (global.get $gimport$3))))
    (local.get $scratch))
  (local.get $2))                       ;; funcref
```

The `global.get` inside that arg-block was emitted as `global.get <f's
global>` (= `global$0`, the closure), but a string-constant import (the
"Cannot access property on null or undefined" message → `gimport$3`) was added
**late**, shifting the import-global indices. The late-import global-index
shifter (`shiftLateImportIndices` / `fixupModuleGlobalIndices`, which walks
`ctx.currentFunc.body` + `fctx.savedBodies` only) did **not** visit this
arg-block's body, so its `global.get` index stayed stale and now points at
`gimport$3` instead of `global$0`. Then `ref.cast (ref null $0)` of that
garbage value traps `illegal cast`. This is exactly the bug class the `#1395`
comment at `calls.ts:~10079` describes and partially fixed for ONE arm — the
direct module-const-arrow arg-block arm is NOT covered.

**Fix direction:** ensure the call_ref argument-block body for this dispatch
arm is tracked in `fctx.savedBodies` (or otherwise visited by the late-import
global-index shifter) — mirror the `#1395` `pushBody`/`savedBodies` pattern
at `calls.ts:10094`. Find which arm builds the `(block (result T))` 2nd
operand for the direct-identifier closure call and confirm its body is in
`savedBodies` before late imports are added. Why `const g = f; g(21)` works:
the intermediate-local store does NOT build a separate arg-block re-resolving
the callee — it loads `global$0` into a local once, in the OUTER body, which
the shifter does visit.

Verify with `tests/equivalence/async-function.test.ts` (un-skip the #1729/#1730
case) + the sync `f(21)→42` case, and watch the equivalence shards for any
late-import-heavy function regressing.

## Repro / acceptance

- `const f = (x:number):number => x*2; main(){ return f(21); }` → 42 (no trap).
- The async-arrow variant (the `it.skip("async arrow function (#1730 ...)")`
  case in `tests/equivalence/async-function.test.ts`) flips green; un-skip it.
- No regression in inline-arrow / callback-arrow dispatch.

## Source

Surfaced while fixing #1727 (async-call NaN). The async-arrow equivalence case
was attributed to async but is a general module-const-arrow dispatch bug;
split out so #1727 ships the actual Promise-wrap fix without expanding into
closure-ABI work.
