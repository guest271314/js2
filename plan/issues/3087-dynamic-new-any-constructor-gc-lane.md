---
id: 3087
title: "codegen: dynamic `new TA(...)` on an any-typed constructor value fails on the gc/host lane (No dependency provided for extern class) — dominant honest-fail after #3074"
status: ready
sprint: Backlog
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: dynamic-construction, typed-arrays, closures
goal: host-independence
related: [3074, 2939, 2940, 1679, 812, 814]
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
