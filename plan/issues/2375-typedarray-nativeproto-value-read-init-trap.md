---
id: 2375
title: "standalone: TypedArray concrete-view $NativeProto value-read materialization traps at module init (base CE → patched init-trap)"
status: backlog
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: builtins, reflection, typedarray
goal: standalone-mode
related: [2374, 2193, 2175, 1907, 1888]
origin: "2026-06-19 — measure-first probe while extending #2374 value-read glue to the TypedArray family"
---

## Problem

Extending the #2374 `$NativeProto` value-read glue to the TypedArray family
(`%TypedArray%` + the concrete views `Int8Array`…`Float64Array`,
`BigInt64Array`/`BigUint64Array`) — the obvious next slice, since the brands
are pre-reserved in `native-proto.ts` `BUILTIN_BRAND_TABLE` (BASE+3..14) and
`property-access.ts` even comments "S3 adds %TypedArray% / the concrete views"
— does **NOT** behave like the String/Number/Boolean wrapper protos.

Registering `ensureTypedArrayNativeProtoGlue` (mirroring
`ensureArrayNativeProtoGlue`) and wiring it into `tryEnsureNativeProtoBrand`
compiles cleanly (tsc 0), but **measured 1/506 flips** on the
`built-ins/TypedArray/prototype` host-pass/standalone-CE set, and worse:

It turns the static-read compile-error into a **`wasm exception during module
init`** — i.e. the module now *compiles* but **traps at instantiation**.

Verified base-vs-patched on
`built-ins/TypedArray/prototype/findLastIndex/this-is-not-object.js`:

| build | result |
|-------|--------|
| base (upstream/main) | `compile_error`: `Int8Array.prototype built-in static property value read is not supported (#1907 / #1888 S6-b)` |
| + TypedArray glue | `fail`: **wasm exception during module init** |

So the `$NativeProto` materialization (`emitLazyNativeProtoGet`) for a
concrete-view brand produces an init-trapping module — a latent defect in the
existing TypedArray brand / object-runtime interaction, NOT a clean additive
value-read win. The String/Number/Boolean protos (#2374) flip 72 with 0
regressions; the TypedArray protos do not, because something in the
concrete-view brand path (likely the interaction with the existing TypedArray
runtime registration / vec-type machinery, or the `$NativeProto` init order vs
the view-brand init) faults at instantiate.

## Why this is filed separately (not folded into #2374)

#2374 stays narrow + clean (wrapper protos only, measured + byte-identical).
The TypedArray family needs the init-trap root-caused first — it is a real
blocker for the TypedArray value-read cluster (~506 host-pass/standalone-CE,
of which ~38/60 sampled are the `Int8Array.prototype` static-read refusal),
but it is hard, not a clean additive slice.

## Repro

```bash
# In a worktree with the TypedArray glue applied (ensureTypedArrayNativeProtoGlue
# + TYPEDARRAY_BUILTIN_NAMES wired into tryEnsureNativeProtoBrand):
npx tsx -e "
import { runTest262File } from './tests/test262-runner.ts';
const r = await runTest262File(
  'test262/test/built-ins/TypedArray/prototype/findLastIndex/this-is-not-object.js',
  'built-ins/TypedArray', 15000, 'standalone');
console.log(r.status, r.reason);  // => fail :: wasm exception during module init
"
```

## Investigation pointers

- `emitLazyNativeProtoGet` (native-proto.ts) builds the `$NativeProto` struct
  for a brand; for the TypedArray concrete-view brands it apparently emits
  init code that traps. Compare the emitted init sequence for a wrapper-proto
  brand (works) vs a concrete-view brand (traps) — likely a type-index or
  global-init ordering issue specific to the view brands.
- The concrete-view brands also drive the existing TypedArray runtime (vec
  types, `$__subview` #2357/#47); the `$NativeProto` value-read path may
  collide with that registration.
- Once root-caused, the value-read cluster (~506) should flip much like
  #2374's 72 — but only after the init-trap is resolved.
