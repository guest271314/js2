---
id: 2923
title: "codegen: dynamic dispatch of an any-typed closure param (fn(...)) must honor JS arity semantics + coerce arg kinds (blocks #2921, unblocks 468+ BigInt tests)"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures, dynamic-dispatch
goal: host-independence
related: [2921, 2903]
created: 2026-07-02
updated: 2026-07-02
origin: "2026-07-02 spun out of #2921 yield-gate analysis (dev-callback). origin/main @ 4d5287afc."
---

# #2923 — dynamic `fn(...)` on an any-typed closure param: arity + kind tolerance

## Problem

When a closure is held in an `any`-typed **parameter** and invoked
(`fn(a, b)`), the compiler's dynamic-dispatch path only invokes the closure
when the **call-site arg count AND each arg's Wasm type-kind exactly match**
the closure's declared parameter list. On any mismatch the call is **silently
dropped** (graceful fallback compiles the args for side-effect and returns
`ref.null.extern`) — the closure body never runs. This violates JS call
semantics (extra args ignored, missing args `undefined`) and silently
no-ops a large class of higher-order code.

This is the blocker under #2921: the test262 `testWith*TypedArrayConstructors`
harness wrapper calls `fn(ctor, makeCtorArg)`, but the callback declares
`function(TA)` (1 param) or its params are `any`/externref while the shim
passes a constructor value + a funcref — either way the kinds/arity don't match
and the whole test body is dead (a *vacuous* pass). Fixing this unblocks
**468+ BigInt TypedArray tests** and is a **general** correctness fix beyond the
harness class.

## Isolated repro (standalone; `.tmp` probes)

```ts
function __ta_passthrough(x: any): any { return x; }
function testWithBigIntTypedArrayConstructors(fn: any): void {
  const constructors = [BigInt64Array, BigUint64Array];
  for (let i = 0; i < constructors.length; i++) {
    fn(constructors[i], __ta_passthrough);   // <-- call SILENTLY DROPPED
  }
}
testWithBigIntTypedArrayConstructors(function (TA: any) { log(999); });
// log(999) never fires -> body vacuous
```

Truth table (call → callback params → invoked?):

| call | callback params | invoked? |
|------|-----------------|----------|
| `fn(x)` | `(TA)` | YES |
| `fn(x, y:number)` | `(TA, m)` | YES |
| `fn(x)` | `(TA, m)` | **NO** (arity: fewer args than params) |
| `fn(x, y)` | `(TA)` | **NO** (arity: more args than params) |
| `fn(ctor[i], namedFn)` | `(TA, makeCtorArg)` | **NO** (arg kinds != externref params) |

## Exact sites

`src/codegen/expressions/calls-closures.ts`:
- **L688** `if (info.paramTypes.length !== sigParamCount) continue;` — the
  exact-arity gate that skips a matching closure whose declared param count ≠
  the call-site arg count.
- **L693–698** per-parameter `sigParamWasmTypes[i].kind !== info.paramTypes[i].kind`
  loop — requires each arg's Wasm kind to match the param kind exactly, with no
  coercion.
- Note: the same file already contains arity-padding helpers for OTHER paths
  (e.g. L724–738 `Math.min(args, paramCount)` truncate + `pushDefaultValue`
  fill), so the intended semantics exist elsewhere — this identifier/any-param
  path just needs to adopt them.

## Required behavior (JS §7.3.14 Call / OrdinaryCallBindThis)

1. **Arity**: match a candidate closure regardless of arg-count vs param-count.
   Truncate extra args (compile for side-effect + drop), and `undefined`-fill
   missing params (`pushDefaultValue`).
2. **Kind coercion**: coerce each passed arg to the closure param's kind
   (`coerceType`) rather than requiring exact-kind equality — a constructor
   value / funcref / number passed into an `any`(externref) param must box to
   externref, etc. Choose the candidate by param **count is no longer a hard
   filter**; disambiguation among multiple registered closure types will need a
   rule (prefer exact-arity, else nearest; or route via the generic
   `__call_fn_N` dispatcher if one exists for the arg count).
3. Preserve existing exact-match fast paths for byte-inertness on the js-host/gc
   lanes.

## Part-1 prototype (from #2921, NOT to ship alone)

The runner shim gap that surfaces this: `tests/test262-runner.ts`
`needsTestTypedArray` gate regex `/testWithTypedArrayConstructors/` misses the
`BigInt` variant; no `testWithBigIntTypedArrayConstructors` shim; shim passes
only 1 arg. Prototype (add BigInt wrapper + passthrough `makeCtorArg` + regex
`/testWith(?:BigInt)?TypedArrayConstructors/`) removes the `__make_callback`
import and instantiates host-free — but MUST land together with this dispatch
fix, else it produces **dishonest vacuous host-free passes** (durable project
rule: leak-elim must prove bodies execute, not just that the import disappears).

## Acceptance / measurement

- The repro above invokes the body (`log(999)` fires) in standalone.
- Then re-measure the #2921 BigInt corpus: with shim + this fix, sample ~30 and
  **compare standalone runtime OUTPUT vs js-host** (a vacuous host-free pass
  must be scored as a FAIL by the harness, not a pass). Report genuine-pass
  fraction. BigInt TypedArray semantics coverage is **unmeasured** — expect
  partial; real fails that surface are honest, not regressions.
- Byte-inert for js-host/gc lanes (sha256); gate any standalone-specific
  behavior on `ctx.standalone`.
- Full `merge_group` net-positive.

## Notes

Spun out of #2921 (blocked_on this). Repro scripts were under `.tmp/` during the
#2921 investigation (dyncall / genuine probes); regenerate from the table above.
