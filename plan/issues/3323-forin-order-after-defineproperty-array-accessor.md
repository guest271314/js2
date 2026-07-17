---
id: 3323
title: "for-in order-after-define-property: array + accessor-descriptor redefine reorders keys (full-harness only)"
status: done
assignee: ttraenkler/opus-c
completed: 2026-07-17
sprint: Backlog
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: ES5
language_feature: for-in
task_type: bug
horizon: s
created: 2026-07-16
updated: 2026-07-17
# (#3323) genuine growth: new __array_forin_keys host helper (runtime.ts), its
# late-import registration (imports.ts), and the host-keys array for-in path
# (loops.ts). Cohesive with each file's existing for-in / sidecar logic.
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/runtime.ts
  - src/codegen/registry/imports.ts
---

# #3323 — for-in order after defineProperty on an ARRAY with an accessor descriptor

Split from #2739 (sub-case (c), per the architect's recommendation there).
Parts (a) setPrototypeOf-chain and (b) fnctor-prototype-chain enumeration
landed via #2199 and the #2739 implementation PR; this array+accessor ordering
case is a DIFFERENT defect and was explicitly carved out.

## Problem

`test/language/statements/for-in/order-after-define-property.js` fails at
assert #2 only:

```js
var arr = [];
Object.defineProperty(arr, "a", { get: function () {}, enumerable: true, configurable: true });
arr.b = 2;
Object.defineProperty(arr, "a", { get: function () {} }); // redefine — must NOT re-create
var arrKeys = [];
for (var key in arr) arrKeys.push(key);
// expected ["a", "b"]; compiled program returns 3 keys / wrong order
```

Verified on main 78a091c574 (2026-07-16, host mode): assert #1 (plain object)
passes; assert #2 (array receiver + accessor descriptor) fails with
`returned 3 — assert #2 at L51`.

## Key repro constraint (from the #2739 architect verification, still true)

The failure reproduces ONLY under the full `runTest262File` harness run
(assert.js + compareArray preamble compiled into the same program) — an
isolated `compile()` probe of the same snippet returns the correct
`["a","b"]`. Reproduce via:

```ts
import { runTest262File } from "./tests/test262-runner.ts";
await runTest262File("/workspace/test262/test/language/statements/for-in/order-after-define-property.js", "smoke");
```

Do NOT chase it with a bare compile() probe — it will not repro.

## Suspected area

Full-program interaction between the array vec receiver, the
accessor-descriptor sidecar (`_wasmPropDescs` / `__get_<k>` sidecar entries),
and the `__for_in_keys` walk's vec/struct level — a `defineProperty` on an
EXISTING key must not move it to insertion-order end (compare
`_wasmStructShadowedFields` handling from #2731).

## Acceptance criteria

`language/statements/for-in/order-after-define-property.js` flips fail→pass
under the full harness; no regressions in `statements/for-in/` or
`built-ins/Object/defineProperty/`.

## Root cause (resolved)

Not a reordering defect — the real bug was that the array-receiver for-in path
(`emitArrayForIn` in `src/codegen/statements/loops.ts`) enumerated ONLY the
integer indices `"0".."length-1"` and **dropped every own enumerable non-index
string key** added via `arr.k = v` / `Object.defineProperty`. So
`for (k in arr)` after `defineProperty(arr,"a",{get,enumerable})` + `arr.b = 2`
yielded `[]` (compareArray length mismatch → assert #2 fail), not `["a","b"]`.
The "returned 3" in the failure message is the harness assert-failure code, not
the array length. The full-harness-only repro constraint was a red herring
(differing static type inference for `var arr = []` selected the array-path vs
the host `__for_in_keys` path).

## Fix

In JS-host mode, `emitArrayForIn` now materializes the full
OrdinaryOwnPropertyKeys string list via a new `__array_forin_keys(vec, len)`
host helper (`src/runtime.ts`): integer indices `0..len-1` (len read in Wasm
from the `$__vec_base` length field and passed in — the opaque vec has no
host-reachable length), THEN the own enumerable non-index string keys from the
sidecar in insertion order, with `__get_<k>`/`__set_<k>` accessor keys
normalized to their user key `<k>` and deduped (so a redefine does not
double-enumerate or reorder), and non-enumerable / deleted keys skipped. The
loop is driven by the shared `__for_in_len`/`__for_in_get` scaffolding. The
standalone / wasi lane keeps the pure-native index-only path (the host-side
sidecar is unavailable there — pre-existing, unchanged).

Import registered in `addForInImports` (`src/codegen/registry/imports.ts`).

## Test Results

- `order-after-define-property.js` (full `runTest262File` harness): fail → **pass**.
- New `tests/issue-3323.test.ts` (6 cases, all pass): accessor define+redefine
  order, indices-before-string-keys, plain array, empty array, non-enumerable
  skip, deleted-key skip.
- Spot-checked individually (each fresh): `for-in/order-simple-object`,
  `order-enumerable-shadowed`, `order-property-added`,
  `order-property-on-prototype`, `12.6.4-2`, `S12.6.4_A2` all pass;
  `tests/define-property-patterns.test.ts` passes.
  (`tests/arrays-enums.test.ts` failures are a pre-existing stale-harness issue
  — it instantiates with a hand-rolled import object lacking `string_constants`,
  and fails even on non-for-in tests; unrelated to this change.)
