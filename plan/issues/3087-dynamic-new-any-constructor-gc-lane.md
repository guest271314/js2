---
id: 3087
title: "codegen: dynamic `new TA(...)` on an any-typed constructor value fails on the gc/host lane (No dependency provided for extern class) — dominant honest-fail after #3074"
status: in-progress
sprint: current
model: opus
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: dynamic-construction, typed-arrays, closures
goal: host-independence
related: [3074, 2939, 2940, 1679, 812, 814, 820]
created: 2026-07-07
origin: "2026-07-07 measured under #3074 keystone validation (dev-keystone): after the HOF-callback dispatch fix lands, the harness callback bodies EXECUTE and honest-fail here — the #1 remaining conversion of un-masked bodies to real passes."
---

# #3087 — dynamic `new TA(...)` on an `any`-typed constructor value (gc/host lane)

## Problem

Once #3074 makes the TypedArray harness-wrapper callback dispatch on the gc/host
lane, the callback body runs `new TA(...)` where `TA` is the constructor value
passed positionally into the `any`-typed callback parameter
(`testWith*Constructors(function (TA) { new TA(3); … })`). The compiler treats a
runtime constructor value used in a `NewExpression` callee position as a **host
extern class** needing an import named after the local (`TA`), which does not
exist, so instantiation/execution fails with:

```
No dependency provided for extern class "TA" in __closure_N() at source L..
```

This is the **dominant honest-fail** for the ~1487-file TypedArray harness
cluster after #3074 — i.e. the biggest single remaining blocker to converting
those (now-honestly-failing) bodies into real passes. Measured: every executing
harness file in the #3074 validation samples honest-failed here.

## Why it surfaced now

#3074 (dispatch of an `any`-typed HOF callback on the gc lane) is a prerequisite:
before it, the callback body never ran, so `new TA(...)` was never reached (the
test was vacuous). #3074 makes the body execute; this construction gap is what
it then hits.

## Scope / approach (needs verification-first)

`new (dynamicCtorValue)(args)` where the callee's static type is `any`/externref
must construct via a runtime dispatch, not a static extern-class import:
- Related dynamic-constructor work: #1679 (`compile-acorn-new-this-dynamic-constructor`).
- Related "No dependency provided for extern class" class: #812 (Test262Error),
  #814 (ArrayBuffer).
- On the gc/host lane a host construct-bridge (`Reflect.construct`-style, or a
  `__construct_dynamic(ctorExternref, args)` import) can invoke the real
  constructor value. On standalone the analogous native-construct path is needed
  (the substrate already special-cases some builtin ctors; a general
  any-ctor `new` is the gap).

## Acceptance

- The #3074 keystone-validation harness files whose bodies do `new TA(...)` flip
  from honest-fail ("No dependency provided for extern class TA") to genuine
  pass (or an honest DIFFERENT failure for a truly-unsupported downstream
  semantic), on the gc/host lane.
- No regression in either lane's pass count.

## Notes

Blocks the TypedArray conformance realization gated behind #3074. This is the
recommended highest-value next step after #3074 (#2790) lands.

## Progress — verified partial landing (2026-07-08, dev-ta)

Verify-first traced the actual failure chain on current main (the "No dependency
provided for extern class TA" is one link in a THREE-link chain, not the whole
story). Two of the three links are FIXED in this PR (gc/host lane); the third is
a deeper dispatch-substrate gap documented below.

### Root-cause chain (gc/host lane), each verified with an isolated repro

1. **Dynamic `new <anyCtor>(...)` routing** — `new TA(...)` where `TA` is an
   `any`-typed value reached the unknown-ctor fallthrough and emitted a
   `__new_TA` extern-class import → runtime "No dependency provided for extern
   class TA". **FIXED**: `src/codegen/expressions/new-super.ts` now routes an
   `any`/`unknown`-typed ctor identifier through the existing
   `__construct_closure` host bridge (runtime side already runs the spec
   IsConstructor probe + `Reflect.construct`). Two placements:
   (a) new `resolvesToDynamicAnyCtorValue` predicate + a branch before the
   `__new_${ctorName}` fallthrough (fires when there are no compiled-class
   candidates); (b) the **no-match base** of `emitDynamicNewFallback` (fires when
   compiled-class candidates exist and the runtime tag matches none — the harness
   case, since harness+includes define compiled classes). Verified:
   `function (K) { new K(7) }` with a user ctor value → **PASS**; compiled-class
   dynamic `new` still **PASS** (no regression).
2. **Bare TypedArray ctor as a VALUE on the gc/host lane** — `Int8Array` /
   `constructors[i]` in value position hit `ctx.declaredGlobals` FIRST, which
   maps a bare TA name to a stub host import returning `undefined`, so the ctor
   value was `undefined` (→ "undefined is not a constructor" once link 1 routed
   it to the bridge). **FIXED**: `src/codegen/expressions/identifiers.ts` now
   resolves a bare TA ctor name (incl. `BigInt64Array`/`BigUint64Array`) via
   `__extern_get(__get_globalThis(), name)` — mirroring the #820h ERM pattern —
   placed BEFORE the `declaredGlobals` route. Verified: `var C = Int8Array;
   new C(4)` (length 4) → **PASS**. gc/host only; standalone keeps `$__ta_ctor`.
3. **REMAINING GAP (not fixed here)** — a host constructor externref passed as an
   argument through a **dynamic `any`-typed call** to a closure is DROPPED:
   `function run(fn){ fn(Int8Array); } run(function (TA){ … })` leaves `TA`
   `undefined` inside the callback (verified: `typeof TA !== "function"`). This
   is in the #3074 closure-dispatch **argument-marshaling** path — a host
   externref arg does not survive the dynamic-call boxing that a compiled-closure
   arg does. Because the TypedArray harness passes `fn(constructors[i])`, the
   cluster still honest-fails here until this is fixed. This is the true final
   blocker for the ~1487-file harness conversion.

### What lands vs. what remains

- **Lands (this PR):** dynamic `new K()` on user-function / class ctor values,
  and bare-TA-ctor-as-value materialization on the gc/host lane. Real, additive
  conformance surface; gc/host-gated (standalone floor untouched); the
  `check for test262 regressions` required check is the arbiter.
- **Remains (follow-up, keep #3087 in-progress):** the dynamic-`any`-call
  argument-marshaling drop of a host externref (link 3). Entry point: the
  `fn(arg)` dynamic-call arg compilation / boxing in the #3074 closure-dispatch
  machinery (`calls-closures.ts` / arg coercion). NOTE: verify whether this
  touches Fable-reserved dispatch substrate before implementing; if so, defer to
  the Fable window. Minimal repro to reopen from: `.tmp` style —
  `function run(fn){ fn(Int8Array); } var got="none";
  run(function(TA){ got = typeof TA; }); assert got === "function"`.
