---
id: 2162b
title: "Standalone array-spread/Array.from of pair-producing iterators ([...map] / [...x.entries()])"
status: in-progress
sprint: 64
created: 2026-06-18
updated: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2162
depends_on: [2162a]
---

# Standalone array-spread / Array.from of pair-producing iterators

## Problem

On standalone (`--target wasi`), spreading any **pair-producing iterator** into
an array literal — or destructuring one — is broken, and it is NOT Map-specific:

```ts
const arr = [10, 20];
[...arr.entries()];        // VALIDATE-FAIL: array.set expected f64, found call externref
const m = new Map<number,number>(); m.set(1, 9);
[...m.entries()];          // VALIDATE-FAIL (identical)
[...m];                    // bare Map → entry pairs: leaks env.__array_from_iter; length 0
Array.from(m.entries());   // VALIDATE-FAIL (same family)
```

Proof it is general: `[...arr.entries()]` (a plain **array** entries iterator,
no Map) fails identically. `for-of ([k,v] of map)` works zero-import (it consumes
pairs inline, never materializing a vec-of-pairs), so the **producer** is fine —
the gap is purely consumer-side **materialization** of `$ObjVec` `[k,v]` pair
externrefs into an array/tuple. Cluster ≈ 300 tests (entries spread/Array.from +
the array-rest / tuple destructuring that shares the materialization path).

## Implementation Plan (architect spec — sdev-iter, 2026-06-18)

The breakage crosses THREE interacting sites. The load-bearing one is (3); fixing
(1)+(2) without (3) does not close it (verified in the #2162b investigation).

### (1) `src/codegen/literals.ts` `compileArrayLiteral` — element-type heuristic

For a spread-first-element, force the **result vec element type to externref**
when the spread source is a pair source — `isPairSpreadSource(spreadType)`:
- `spreadType.symbol?.name === "Map"` (bare `[...map]` → `[k,v]` pairs §24.1.3.*), OR
- name matches `/Iterator$/` (`ArrayIterator`/`MapIterator`/`SetIterator`) AND its
  first type-arg is a TUPLE (`isTupleTypeArg`) — i.e. `.entries()`, not
  `.keys()`/`.values()` (those stay scalar). Discriminators confirmed via the
  checker (`ArrayIterator`/`MapIterator` + `objectFlags & Reference`, target
  `objectFlags & Tuple`).
The pair element is an externref `$ObjVec`, so an f64/i32 backing array can't hold
it. Scalar iterators keep their numeric result type and #2162a's per-element
fill-loop coerce handles them — UNCHANGED.

### (2) `compileArrayLiteral` spread loop — route bare `[...map]`

Extend #2162a's Set branch: a bare `Map` subject routes through
`emitCollectionIteratorVec(ctx, fctx, el.expression, "entries", /*isSet*/ false)`
(the same for-of driver, which already builds `$ObjVec` pairs via
`ensureObjVecBuilders`). It returns a canonical externref `$Vec`; the fill loop
consumes it (externref→externref no-op coerce, now that result elem is externref
from (1)).

### (3) `src/codegen/type-coercion.ts` `buildTupleFromIterableFallback` (~L374) — THE load-bearing change

This is the `__tup_mat_*` path. It currently:
- materializes the externref via **`__array_from_iter`** (a HOST import — the
  `env.__array_from_iter` leak in bare `[...map]`), then
- reads each field by `__extern_get_idx` + per-field `__unbox_number`.

For the **spread fill** path the source vec is already a WasmGC `$Vec` of
externref pairs (from (2)) — so the array-literal Step-3 fill loop must copy the
pair externref DIRECTLY into the externref result array (no per-field unbox, no
`__array_from_iter`). The `__tup_mat_*` tuple-struct build is the
DESTRUCTURING path (`const [a,b] = pairExternref` — e.g. `for (const [k,v] of
[...map])`). There, when the source resolves to a native collection, route it
through `emitCollectionIteratorVec` FIRST (standalone-native, zero host import),
THEN destructure the resulting `$Vec` via the existing typed-vec
`buildTupleFromExternref` branch — NOT the `__array_from_iter` fallback. Gate the
`__array_from_iter` fallback behind `!noJsHost(ctx)` so standalone never emits it
(falls to `ref.null` → the existing destructure guard throws the spec TypeError,
which is at least valid Wasm and host-import-free).

### (4) Nested `a[0][1]` pair read

Reading `pair[1]` off an externref `$ObjVec` already works in standalone via the
`__extern_get_idx` arm (verified: `[...set][0]` reads correctly in #2162a). For
a pair the inner index read is the same arm; confirm it stays host-import-free
for the entries case (it should, since `$ObjVec` is a WasmGC struct).

## PR split (tight, to bound the high-regression blast radius)

`buildTupleFromExternref`/`__tup_mat_*` backs ALL tuple/`[k,v]` spreads &
destructuring, so split:

- **PR-A** — (1)+(2): force-externref + bare-`[...map]` routing in `literals.ts`
  only. Closes `[...arr.entries()]`/`[...map.entries()]`/`[...map]` SPREAD into a
  variable + nested index. Does NOT touch type-coercion.ts. Lowest blast radius;
  ship + measure first.
- **PR-B** — (3): the `type-coercion.ts` `__tup_mat_*` host-leak removal +
  native-collection destructure routing. Higher blast radius (destructuring of
  ALL iterables). Ship only after PR-A is green on the shard.

## Regression-guard strategy (REQUIRED gate, run before AND after each PR)

- Full local suites: `tests/{issue-2169-*,issue-2151-spread-literal,
  issue-2162-collection-from-array,basic-destructuring,array-rest-destructuring,
  for-of-array-destructuring,for-of-generator,issue-2079,issue-2172,issue-42-*}`.
- **WAT-diff a plain `[a,b]=[1,2]` tuple destructure + a plain `[...arr]`** (no
  pairs) — confirm NON-pair tuples/spreads are byte-identical (the change must be
  gated strictly on pair sources / native collections).
- `pnpm run check:ir-fallbacks` OK. Hard floor-gate the standalone HW shard
  (no breach of 20,803).
- Helpers BY NAME (#2191 lesson — never index a funcIdx captured before a later
  import-adding phase).

## Source

Root-caused in the #2162b investigation (2026-06-18, sdev-iter); spec written by
sdev-iter per tech-lead direction (own-lane, zero collision). Implement PR-A then
PR-B from this spec.
