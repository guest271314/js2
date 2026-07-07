---
id: 3089
title: "codegen: BigInt TypedArray tests fail to compile — 'Binary emit error: RangeError: offset is out of bounds' (i64 codegen, ~22/30 sampled, pre-existing)"
status: ready
sprint: Backlog
priority: medium
horizon: m
feasibility: hard
task_type: bugfix
area: codegen
language_feature: bigint, typed-arrays, i64
goal: host-independence
related: [3074, 1349, 1644]
created: 2026-07-07
origin: "2026-07-07 surfaced (not caused) during #3074 keystone validation (dev-keystone): the BigInt-TA harness sample is dominated by a compile-time binary-emit RangeError, independent of dispatch."
---

# #3089 — BigInt TypedArray compile error: `Binary emit error: RangeError: offset is out of bounds`

## Problem

A large fraction of `built-ins/TypedArray*/**/BigInt/**` and
`ctors-bigint/**` tests fail at COMPILE time with:

```
L..:1 Binary emit error: RangeError: offset is out of bounds
```

Measured under #3074's keystone validation: **~22 of 30** sampled
`testWithBigIntTypedArrayConstructors` files are `compile_error` with this exact
signature — **independent of the closure-dispatch fix** (they were already
`compile_error` on `main`; #3074 does not change them). Sample:
`TypedArrayConstructors/from/BigInt/inherited.js`,
`ctors-bigint/object-arg/iterating-throws.js`,
`TypedArray/prototype/slice/BigInt/return-abrupt-from-start.js`.

## Why filed now

It is the **third downstream gap** (alongside #3087 dynamic-`new TA` and #3088
runner-shim faithfulness) standing between the #3074 keystone and real BigInt
TypedArray conformance. Tracked so the BigInt-TA cluster's blockers are
enumerated. Pre-existing i64/BigInt codegen defect — NOT a #3074 regression.

## Scope / approach

The `Binary emit error: RangeError: offset is out of bounds` is a binary-encoder
overflow (a LEB/section offset computed out of range) triggered on the i64/BigInt
paths these tests exercise. Needs a verify-first trace of one minimal repro to
localize the encoder site (likely an i64 constant / memory-offset / type-section
index miscomputation on the BigInt TypedArray element path). Related BigInt i64
work: #1349 / #1644 (i64-brand ValType).

## Acceptance

- The sampled BigInt-TA `compile_error` files compile (then pass or honest-fail
  on downstream semantics), on both lanes as applicable.
- No net regression.
