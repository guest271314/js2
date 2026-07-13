---
id: 3242
title: Native standalone WeakRef — retire WeakRef_new / WeakRef_deref host imports
status: done
completed: 2026-07-13
assignee: opus-weakcoll
sprint: 71
priority: high
horizon: m
goal: standalone-mode
umbrella: 1781
feasibility: hard
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/extern.ts
---

# Native standalone WeakRef (host-free)

## Problem

In `--target standalone` / `--target wasi` (`nativeStrings`) mode there is no JS
host, yet `new WeakRef(o)` routes through the generic externClass constructor
path and emits a `WeakRef_new` host import, and `wr.deref()` emits
`WeakRef_deref`. These are the last **sole-import** host-free leaks in the
weak-collections family — `WeakMap` / `WeakSet` were already made native in
#2162, but `WeakRef` was left on the host ctor table.

Reproduced on current main (vitest probe against `src/`):

- `new WeakMap(); wm.set/get/has/delete` → **0 env imports** (already native).
- `new WeakSet(); ws.add/has/delete` → **0 env imports** (already native).
- `new WeakRef(o); wr.deref()` → **`WeakRef_new`, `WeakRef_deref`** (leak).

11 currently-passing standalone WeakRef tests are "leaky passes" (they pass only
because the standalone harness stubs the `env` imports); they violate the
host-free contract. Making WeakRef native flips them to `host_free_pass`.

## What the passing tests actually need (measured)

The 11 passing standalone WeakRef tests are:
`WeakRef/{constructor,length,name,prop-desc}.js`,
`WeakRef/prototype/prop-desc.js`,
`WeakRef/prototype/deref/{length,name,not-a-constructor,prop-desc,return-object-target,return-symbol-target}.js`.

Only two exercise an **instance**: `deref/return-object-target.js` and
`deref/return-symbol-target.js`. Both assert exactly one thing —
`new WeakRef(target).deref() === target` (identity preserved across repeated
derefs), with `target` being an object OR a symbol. **No passing test observes
GC weakness, `[[WeakRefTarget]]` emptying, `instanceof WeakRef`, or
`Object.prototype.toString` on an instance.**

So a **strong-backed** native WeakRef — a WasmGC struct holding the target as a
single immutable `anyref` field — flips all 11 host-free with zero regression.
There is no real weak (collectible) semantics; WasmGC has no weak refs and no
passing spec test can observe the difference (the liveness tests that could are
already `fail`/skip-filtered). This mirrors the #2162 WeakMap/WeakSet decision
(strong-backed Map reuse).

## Implementation

- `src/codegen/weakref-runtime.ts` (new): `ensureWeakRefStruct(ctx)` lazily
  registers a `$WeakRef` struct `{ target: anyref (immut) }` (appended to
  `ctx.mod.types`, index in `ctx.weakRefTypeIdx`); `tryCompileNativeWeakRefNew`
  and `tryCompileNativeWeakRefDeref` emit the `struct.new` / `struct.get 0`.
- `src/codegen/expressions/new-super.ts`: intercept `new WeakRef(x)` when
  `ctx.nativeStrings` and exactly one arg → coerce arg to anyref, `struct.new
  $WeakRef`. Returns `ref $WeakRef`.
- `src/codegen/expressions/extern.ts`: intercept `wr.deref()` when
  `className === "WeakRef"` && `ctx.nativeStrings` → cast receiver to
  `$WeakRef`, `struct.get 0` → anyref.
- `src/codegen/context/types.ts`: add `weakRefTypeIdx: number` (init `-1`).

Host / gc lanes are untouched (gated on `nativeStrings`), so those outputs stay
byte-identical.

## Acceptance

- The 3-op WeakRef repro compiles standalone with **0 env imports**.
- The 11 passing WeakRef standalone tests remain passing, now host-free.
- Host / gc lane byte-identical; standalone floor NET ≥ 0.
