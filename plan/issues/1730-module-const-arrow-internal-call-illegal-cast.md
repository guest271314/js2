---
id: 1730
title: "internal call to a module-level `const` arrow traps with illegal cast"
status: done
created: 2026-05-29
updated: 2026-05-30
completed: 2026-05-30
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

---

## 2026-05-30 — sdev-vm checkpoint: trapping global.get refined; fix site differs from handoff

Reproduced cleanly on current main (`const f=(x)=>x*2; main(){return f(21)}` →
"illegal cast"; `g=f; g(21)` → 42). Dumped the WAT for the repro — the exact
trap is:

```wat
;; receiver load (CORRECT, post-shift):
global.get 4          ;; the closure struct value
local.tee 0
;; ... null-check on receiver ...
;; callee RE-RESOLUTION for the funcref operand (STALE):
global.get 3          ;; <-- BUG: should be `global.get 4`. global 3 = "" string-const import
any.convert_extern
ref.cast null (ref null 6)   ;; casts the string-const externref → closure struct → TRAP
```

So the receiver load is shifted correctly but the **callee re-resolution**
`global.get` kept its pre-shift index (3 instead of 4). A late string-constant
import (`gimport$3`) shifted the import-global indices; the receiver-load
participated in the shift but the funcref-re-resolution `global.get` did not.

**Refinement vs the handoff (important for whoever finishes this):** the trap is
NOT emitted via `emitGuardedFuncRefCast` (I added a stderr trace at all
`emitGuardedFuncRefCast` call sites in calls.ts — none fired for this repro), and
it is NOT the #1395 callback-arrow arg-block at `calls.ts:~10094` (that path is
already `pushBody`-wrapped). The WAT signature — `struct.get <s> 0` + inline
`ref.test (ref <f>)` + `(if (result (ref null <f>)))` funcref-extract + `call_ref`
— is the **closure-dispatch path**, and the stale `global.get` is the
**module-const-arrow singleton-cache re-resolution** (`global.get cacheGlobalIdx`
in `src/codegen/closures.ts` ~3452–3595, the `compileArrowAsClosure` cache
materialization). That `global.get` is emitted into a body that the late-import
global-index shifter (`shiftLateImportIndices`/`fixupModuleGlobalIndices`, which
walks `currentFunc.body` + `savedBodies` + `liveBodies`) does not visit.

**Fix direction (unchanged in spirit, corrected in location):** register the
body that holds the cache-re-resolution `global.get` in the set the shifter
walks (`savedBodies`/`liveBodies`), OR resolve the cache global into an OUTER-body
local once (like `g=f` does — `g=f; g(21)` works precisely because the load lands
in the outer body which IS shifted). The latter (hoist the funcref load to a
local in the already-tracked outer body) is likely the smaller, safer fix and
avoids a double-shift risk from a wrong savedBodies registration.

Status: handed back — sdev-vm pivoted to the #1584 VM op-family dispatch (higher
priority; sdev-emitter2's families landing). No code change committed; the
refined root-cause + WAT above is the resume point.

## FIXED (senior-dev sdev-cpr2, 2026-05-30, branch issue-1730-const-arrow)

The trapping site is `compileClosureCall` in
`src/codegen/expressions/calls-closures.ts` (NOT the `emitCachedFuncClosureAccess`
cache path, NOT the `calls.ts` callable-param ladder). For a module-`const`-bound
arrow whose `__mod_<name>` global stores a **typed closure ref** (`(ref null
$struct)`, not externref), `effectiveLocalIdx` stays undefined, so the inner
`pushClosureRef` helper emits `global.get moduleIdx` directly. `pushClosureRef`
is called **twice** — once for the receiver/self (before args) and once for the
funcref re-resolution (after args).

`moduleIdx` was captured **once** as a `const` at function entry
(`calls-closures.ts:34`). While the call arguments compile (between the two
pushes), a late string-constant import is added — for this repro the function
name `f` itself becomes a `string_constants` import — which runs
`fixupModuleGlobalIndices` (`registry/imports.ts:129`). That shifter:
- bumps every module-global index by +1, INCLUDING rewriting the
  already-emitted receiver `global.get` in `fctx.body` (3→4 ✓), and
- updates the `ctx.moduleGlobals` map (3→4 ✓).

But the **second** `pushClosureRef` then emits a NEW `global.get` using the
**stale captured `const moduleIdx`** (still 3), AFTER the shift already ran, so
the shifter never visits it. Index 3 now points at the late string-constant
import global (an externref), and the subsequent funcref-extract / `ref.cast`
of that value to the closure struct traps `illegal cast`. WAT confirmed:
pre-fix the funcref-resolution `global.get 3` vs the receiver `global.get 4`;
post-fix both are `global.get 4`.

`g = f; g(21)` works because the intermediate-local store loads `__mod_f` into
an outer-body local once (which the shifter does visit), so the call dispatches
through the local — never re-resolving the global a second time post-shift.

**Fix (the safer of the two directions above, generalized):** re-read
`ctx.moduleGlobals.get(varName)` on **every** `pushClosureRef` instead of reusing
the captured `const moduleIdx` (`?? moduleIdx!` as a fallback for the rare case
the name left the map). One-site change; reads the live, already-shifted map so
the index is always current. No new savedBodies registration → no double-shift
risk.

**Verified:** `const f=(x:number):number=>x*2; main(){return f(21)}` → 42 (was
trap); async variant `const double = async (x)=>x*2; main(){return double(21)}`
→ 42 (the originally-skipped `tests/equivalence/async-function.test.ts` case,
now un-skipped); two distinct module-const arrows + multi-call cases → correct;
`g=f; g(21)` control still 42. Regression test `tests/issue-1730.test.ts`
(5 cases). Full `tests/equivalence/` suite + tsc clean.
