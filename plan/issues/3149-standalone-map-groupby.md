---
id: 3149
title: "standalone: Map.groupBy (12 __get_builtin CEs)"
status: done
completed: 2026-07-11
sprint: 71
priority: medium
horizon: s
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 2162, 2863]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/type-coercion.ts
---

# #3149 — standalone Map.groupBy

## Problem

`Map.groupBy(items, callback)` used standalone hard-CEs through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **12** non-pass
standalone entries under `built-ins/Map/groupBy/`. (Object.groupBy is a
sibling; check whether it clusters here too and fold it in if so.)

## Sample paths

- `test/built-ins/Map/groupBy/negativeZero.js`
- `test/built-ins/Map/groupBy/callback-throws.js`
- `test/built-ins/Map/groupBy/invalid-callback.js`
- `test/built-ins/Map/groupBy/map-instance.js`

## Shared-infra deps

- Needs `Map.groupBy` as a resolvable standalone builtin: iterate the iterable,
  call the callback per element, `CanonicalizeKeyedCollectionKey` (the -0→+0
  normalization the `negativeZero.js` test asserts), and append into a Map
  keyed by the callback result. Reuses the standalone Map runtime (#2162) +
  the iterator-protocol substrate. Small (12 tests, S) — good tail-filler.
  The `groupBy` grouping helper (`#2863` groupBy landed for arrays?) may share
  code — check before implementing.

## Acceptance

- `built-ins/Map/groupBy/*` standalone tests compile + pass with 0
  regressions.

## Completion (fable-wasm, 2026-07-11) — the anyref→vec coercion root cause, fixed

Resumed fable-sub2's 80% branch. The "one remaining bug" was precisely the
`any`-typed-parameter coercion class:

**Root cause (pinpointed):** `map.get(k)` returns **anyref** (`__map_get -> anyref`,
`tryCompileNativeMapMethodCall`), whereas `Object.groupBy(...).odd` returns
**externref** (`__extern_get`). When the group value flows into the harness's
`compareArray(a: any[], …)` param, the `any[] = ref_null $vec` coercion runs.
The `externref → ref` arm (type-coercion.ts) already MATERIALIZES a real vec via
`buildVecFromExternref` (reads the source through `__extern_length` /
`__extern_get_idx`, which an `$ObjVec` responds to) on a cast-miss. The
**anyref → ref / ref_null** arms did NOT — they dropped to `ref.null` +
`ref.as_non_null`, so the harness's `a.length` read NULL-DEREF-TRAPPED
(`dereferencing a null pointer in assert_compareArray`).

**Fix (src/codegen/type-coercion.ts):** in both the `anyref/eqref → ref` and
`anyref/eqref → ref_null` arms, when the target is a VEC struct
(`getVecInfo(ctx, toIdx)`) and the direct `ref.test` misses, `extern.convert_any`
the source and materialize via `buildVecFromExternref` — mirroring the externref
arm. Non-vec struct targets keep the null fallback (byte-inert). This is GENERAL
(any anyref→vec cast-miss), not Map-specific.

**Result — Map.groupBy standalone 5 → 8 pass** (the +3 compareArray-on-group
cluster: `evenOdd`, `groupLength`, `negativeZero`). Zero regressions:
`Object/groupBy`, `Map/forEach`, `Array/from`, `Array/flat` sweeps (both lanes)
byte-for-byte unchanged counts with/without the fix; 12-program corpus
byte-identical to no-fix (the change is inert unless the anyref→vec cast misses).
New `tests/issue-3149-map-groupby-group-vec-coercion.test.ts` (3 standalone
harness tests). `issue-2863-standalone-groupby` + `issue-1382` pass.

**Still open (roll forward — distinct root causes, NOT this coercion class):**

- `string.js` / `toPropertyKey.js` — the `Array.from(map.keys())` comparison
  (assert #1) fails on a KEY-representation/equality gap (a boxed key element vs
  a native-string literal under `!==`); unmasked now that the group null-deref is
  gone. Same family as the #2899 `any!==any` value-equality gap (filed P1).
- `emptyList.js` — `notSameValue(original, map)` identity assertion.
- `invalid-callback.js` — non-callable callback must throw TypeError before
  iterating.
- `invalid-iterable.js` / `iterator-next-throws.js` — non-indexable iterable
  items (the #2864 iterator-carrier follow-up; out of this slice).
