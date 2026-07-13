---
id: 3250
slug: standalone-buffer-family-proto-getter-gopd-brandcheck
title: "Standalone: gOPD on un-wired buffer-family proto getters returns undefined → `.get` traps (brand-check cluster)"
status: done
assignee: opus-tabrand
sprint: 71
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
completed: 2026-07-14
---

## Problem

Host-free-fail cluster #2 (~925 `type_error: Cannot access property on null or
undefined`). A large sub-slice is the TypedArray/ArrayBuffer/SharedArrayBuffer/
DataView **accessor brand-check** family, e.g.
`built-ins/ArrayBuffer/prototype/byteLength/this-is-not-object.js`,
`built-ins/TypedArray/prototype/buffer/this-has-no-typedarrayname-internal.js`.

These tests do:

```js
var getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
assert.throws(TypeError, function() { getter.call({}); });
```

Under `--target standalone` they fail **at the `.get` deref**, not inside the
getter: `Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")`
returns `undefined`, so `.get` throws our "Cannot access property on null or
undefined".

## Root cause (re-characterized)

opus-leak3 characterized this as "missing this-brand-check TypeError inside the
getter." That is downstream — the tests never reach the getter call. The real
root:

`ensureStandaloneNativeMethodClosure` (src/codegen/native-proto.ts) gated its
`refusalBodyFallback` on `kind === "method"`. An **un-wired proto accessor
GETTER** (whose glue `emitMemberBody` returns `null` — a refusal) therefore
produced a **null closure**. The #2885 Site-2 gOPD synthesis (calls.ts) needs
that closure to build the accessor descriptor; with `null` it bailed to the
dynamic `__getOwnPropertyDescriptor` native, which does not model virtual
`$NativeProto` accessors → answered `undefined`. Hence the `.get` trap.

Un-wired getters (glue uses `emitProtoMemberBodyRefusal`):
- `ArrayBuffer.prototype.{byteLength, maxByteLength, detached, resizable}`
- `SharedArrayBuffer.prototype.{byteLength, maxByteLength, growable}`
- `DataView.prototype.{buffer, byteLength, byteOffset}`
- `%TypedArray%.prototype.buffer`

(`%TypedArray%.prototype.{length, byteLength, byteOffset}` are already wired via
`emitTypedArrayProtoMemberBody`, so they were unaffected.)

## Fix

Extend the `refusalBodyFallback` to accessor getters (drop the
`kind === "method"` restriction). An un-wired getter now reifies as an
identity-stable closure whose body throws a real catchable `TypeError`. gOPD
then synthesizes a spec-shaped accessor descriptor `{ get, set: undefined,
enumerable: false, configurable: true }`, and `desc.get.call(nonBranded)` /
`desc.get()` throws the expected `TypeError`.

### Why this is spec-correct (not just test-passing)

Unlike RegExp's §22.2.6 legacy accessors (which special-case
`SameValue(this, %Proto%) → return undefined`, and whose getters ARE wired), the
buffer-family getters (§23.2.3, §25.1.5, §25.2.5, §25.3.4) have **no
proto-identity carve-out**: `RequireInternalSlot` throws for `this ===
<Ctor>.prototype` and for any non-view/non-buffer `this`. So an unconditional
`TypeError`-throwing getter body is the correct observable behavior for every
receiver these tests pass. A getter with a real wired body is unaffected — its
`emitMemberBody` returns non-null, so the fallback never fires (verified
byte-inert on the wired-getter control set).

### Downstream / blast radius

- Only affects getters whose `emitMemberBody` returns `null` (the buffer-family
  list above). Every wired getter is byte-identical.
- Two opted-in callers see the getter now: the Site-2 gOPD synthesis (the fix
  target) and the `<Ctor>.prototype.<getter>` VALUE-read path
  (native-proto-value-read.ts Tier 1) — for the latter, reading e.g.
  `ArrayBuffer.prototype.byteLength` now throws `TypeError`, which is
  spec-correct (was `undefined`). The Tier-2 inherited path and the
  generator-proto caller hard-code `"method"`, so they are untouched.
- Host / gc / wasi lanes never reach this standalone path.

## Validation (cold, standalone lane)

- Scoped getter dirs (120 tests): **36 → 73 pass, +37 flips, 0 regressions**.
- Control (RegExp/Map/Set wired getters + `%TypedArray%` length/byteLength/
  byteOffset + Symbol.toStringTag + DataView/buffer, 144 tests): **0 changed
  files** — byte-inert.
- 200 random currently-passing standalone tests: **0 real regressions**.
- Broad cluster chunk (94 previously-failing TA/AB/DV null-access fails): 32 now
  pass (~34%); full-cluster flip ceiling ≈ 100+.

Merge gate: standalone floor on `merge_group`.
