---
id: 3323
title: "for-in order-after-define-property: array + accessor-descriptor redefine reorders keys (full-harness only)"
status: ready
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
updated: 2026-07-16
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
