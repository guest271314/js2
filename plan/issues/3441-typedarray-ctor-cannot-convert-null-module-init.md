---
id: 3441
title: "TypedArray constructor cluster throws 'Cannot convert null to object' at __module_init (2,069 default-lane fails)"
status: ready
created: 2026-07-19
priority: high
task_type: bug
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3417, 2375, 1623]
---

# #3441 — TypedArray ctor `Cannot convert null to object` at `__module_init`

## Summary

Harvest of the 2026-07-19 published baselines (default / JS-host lane, oracle v8)
surfaced the **single largest default-lane failure cluster**:

```
runtime_error: Cannot convert null to object [in __module_init()]
```

**2,069 official records**, thrown during module init (before the test body runs),
dominated by TypedArray constructor tests:

| category | count |
| --- | ---: |
| built-ins/TypedArray | 1,316 |
| built-ins/TypedArrayConstructors | 619 |
| built-ins/Atomics | 90 |
| built-ins/Array | 12 |
| built-ins/Proxy | 7 |

This is **not** in the #3417 oracle-v8 reclassification umbrella table (which
covers `async-marker` #3421, `strict-rerun` #3422, module-global-`undefined`
#3423, duplicate-identifier #3419, etc.). #3423 tracks
`Cannot convert **undefined** or null to object [in verifyProperty()]` — a
distinct signature (undefined, and thrown in `verifyProperty`, not
`__module_init`). This cluster is `null` specifically, thrown in
`__module_init()`, and is TypedArray-constructor-centric — a separate bug.

## Sample paths

- `test/built-ins/TypedArrayConstructors/ctors/length-arg/use-default-proto-if-custom-proto-is-not-object.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/detached-buffer.js`
- `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm-sab.js`

## Root cause (hypothesis)

The error fires in `__module_init()` — i.e. while the compiled module's top-level
code runs, **before** the test assertions. The TypedArray-ctor test corpus leans
on `%TypedArray%`-intrinsic reflection and `testWithTypedArrayConstructors` /
`testTypedArrayConversions` harness helpers that walk the TypedArray constructor
list and read `.prototype` / `[[Prototype]]` chains. A read that resolves to
`null` where an object is expected (e.g. `%TypedArray%.prototype`,
`ctor.prototype`, or a proto-from-ctor-realm lookup returning the null sentinel
instead of the intrinsic object) is coerced with a `ToObject`-style operation and
throws `TypeError: Cannot convert null to object`.

Likely the same missing-native-proto-value-read family as **#2375** (standalone
TypedArray `$NativeProto` init-trap) surfacing in the **default** lane under the
oracle-v8 harness, which exercises the real upstream harness reflection instead of
the old synthetic surrogate.

## Suggested fix

1. Reproduce with one sample under the real oracle-v8 harness
   (`testWithTypedArrayConstructors`) and capture which read yields `null`.
2. Check the `%TypedArray%` intrinsic and per-ctor `.prototype` value-reads in
   codegen — ensure they resolve to the native prototype object, not the null
   sentinel, in the JS-host lane.
3. Cross-check against #2375 (standalone init-trap) — a shared native-proto
   value-read fix may close both lanes.

## Regression note

Filed from the 2026-07-19 harvest. Largest single coherent untracked default-lane
bucket. If a prior harvest recorded a lower count for TypedArray-ctor
`module_init` traps, treat growth as a v8-harness reclassification exposure rather
than a new codegen regression (the v8 flip #3370 made the real harness
authoritative).
