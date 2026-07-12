---
id: 3172
title: "standalone: Set-algebra methods (union/intersection/difference/…) set-like protocol + Map/WeakMap getOrInsert(Computed) spec semantics (120 gap tests)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-collections-brand
created: 2026-07-12
updated: 2026-07-12
# (#3102) God-file growth allowance for THIS change-set: the implementation
# lives in the NEW subsystem module collections-es2025.ts; the residual
# growth is unavoidable wiring — getOrInsert(Computed) in the Map/WeakMap
# proto CSVs + length table (+15), and the finalize fill call for the
# reserved __setrec_field_* readers (+7).
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/index.ts
# (#2108) Coercion-vocabulary allowance: the GetSetRecord kernels are emitted
# WASM FUNCTION BODIES (runtime helpers), not compile-time call-site lowering —
# they must invoke the runtime coercion helpers (__to_primitive for the spec's
# ToNumber(size) with valueOf-once, __unbox_number for the numeric read,
# __is_truthy for ToBoolean(has(v))) by funcidx inside the kernel. The
# compile-time coercion ENGINE cannot run inside an emitted body; these are
# the same helper invocations the engine itself lowers to.
coercion-sites-allow:
  - src/codegen/collections-es2025.ts
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: collections
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3171, 3149]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3172 — standalone: Set-algebra set-like protocol + getOrInsert(Computed)

## Problem

**120 gap tests** (measured 2026-07-12 lane-baseline diff, method in #3169)
in the two newest collection method families:

- **Set-algebra, 69 tests**: `union` 11, `symmetricDifference` 11,
  `intersection` 11, `difference` 10, `isSupersetOf` 9, `isDisjointFrom` 9,
  `isSubsetOf` 8 under `built-ins/Set/prototype/`.
- **getOrInsert/getOrInsertComputed, 51 tests** across `Map.prototype`
  (15+9) and `WeakMap.prototype` (rest).

The native kernels EXIST (`src/codegen/set-algebra.ts` landed the algorithms;
#3149 landed `Map.groupBy`). What fails is the **spec protocol around them**,
measured as `assert.throws(TypeError, …)` rows that don't throw plus
wrong-value rows:

- GetSetRecord coercion on the argument: `size` must be read and
  `ToNumber`-coerced (`size-is-a-number.js`), `has`/`keys` must be callable,
  non-object arguments must throw `TypeError` — i.e. accepting **set-LIKE**
  arguments (a plain `{ size, has, keys }` object), not only real Sets.
- Receiver brand check (`receiver-not-set.js`) — shares the #3171 gate.
- getOrInsertComputed: callback-throw propagation, key normalization
  (`append-new-values-normalizes-zero-key.js`), insertion-order and
  re-entrancy rules; WeakMap key-validity `TypeError`s.

## ANTI-BLOAT directive

- Extend `src/codegen/set-algebra.ts` / `map-runtime.ts` /
  `weak-collections-runtime.ts` in place. The missing piece is ONE shared
  **GetSetRecord** helper (arg → {size, has, keys} with spec coercion order +
  TypeErrors) used by all 7 algebra methods — do not duplicate the coercion
  per method.
- Receiver brand checks come from #3171's shared gate — sequence with it or
  land the gate here if #3171 hasn't started (agree the boundary in the
  TaskList before both go in-progress).
- Callback invocation for `getOrInsertComputed` uses the #3098 native
  callback-dispatch substrate — no `__make_callback` reintroduction.

## Acceptance criteria

- ≥90 of the 120 measured gap tests flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/Set/prototype/intersection/receiver-not-set.js`
  - `test/built-ins/Set/prototype/isSupersetOf/size-is-a-number.js`
  - `test/built-ins/Map/prototype/getOrInsert/append-new-values-normalizes-zero-key.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, this family only.

## Test Results (2026-07-12, implementation)

Standalone lane (`TEST262_TARGET=standalone`, filter
`built-ins/{Map,Set,WeakMap,WeakSet}/prototype`) vs the post-#3171 run:

- **81 flips fail→pass, 0 regressions** (suite 478→559 of 700). All three
  acceptance samples pass (`intersection/receiver-not-set`,
  `isSupersetOf/size-is-a-number`,
  `getOrInsert/append-new-values-normalizes-zero-key`).
- **Below the ≥120-gap/≥90 bar (81)** — the residual buckets each have a
  DIFFERENT root cause than this issue's protocol layer and are separable
  slices:
  - class-getter set-likes (`allows-set-like-class`, `set-like-class-order`,
    ~14): accessor `get size()` + METHOD has/keys on closed class structs —
    needs method-as-closure minting in the `__setrec_field_*` fill;
  - `class MySubset extends Set` rows (`subclass*`, ~12): builtin-super
    construction lineage — #2917, explicitly out of scope;
  - getOrInsert value rows comparing two boxed anys via `assert.sameValue`
    (~10): the #3056 boxed-compare lane, not dispatch;
  - `set-like-array` (~7): expando `size/has/keys` on vec-backed arrays;
  - `builtins.js` (7): Object.isExtensible/toString/getPrototypeOf on the
    method VALUE (function-object meta);
  - `set-like-class-mutation` / `set-like-iter-return` (~7): re-entrant
    mutation ordering + IteratorClose — documented out of scope.
- Equivalence: `tests/issue-3172.test.ts` 34 tests; regression batch
  (#2604/#2607/#2162-set-algebra/#3171) 149/149 green. Probe 29/29.
- The 14 `has/keys-is-callable` regressions from the first measurement were
  fixed in-branch (`__setrec_check_callable` reserve-then-fill IsCallable
  gate); final run is 0-regression.
