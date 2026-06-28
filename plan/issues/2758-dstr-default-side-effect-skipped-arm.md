---
id: 2758
title: "Object/array-pattern default-init side-effect runs when element is present (init-skipped) — call default eagerly evaluated / closure-box in skipped arm"
status: ready
created: 2026-06-28
updated: 2026-06-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
parent: 2669
related: [2669, 2692]
sprint: current
---
# #2758 — dstr default-init side-effect on init-skipped

Carved from the #2669 destructuring umbrella (sd-dstr-objdefault, 2026-06-28).
**Route through architect** — entangled with the closure-box machinery that
regressed in #1177 / PR#166 / #2692 (which deliberately deferred the `let`/`const`
+ this surface). Hard; do NOT inline-patch.

## Repro (verified on current `origin/main` @ #2201, fresh single-file FAIL)

```
language/statements/function/dstr/obj-ptrn-id-init-skipped.js
  -> assert #5 at L61: assert.sameValue(initCount, 0)   (initCount != 0)
```
The test:
```js
var initCount = 0;
function counter() { initCount += 1; }
function f({ w = counter(), x = counter(), y = counter(), z = counter() }) {
  assert.sameValue(w, null); assert.sameValue(x, 0);
  assert.sameValue(y, false); assert.sameValue(z, '');
  assert.sameValue(initCount, 0);   // <-- FAILS
}
f({ w: null, x: 0, y: false, z: '' });   // all present → no default fires
```
All four properties are **present** (`null`/`0`/`false`/`''` — falsy but defined),
so per §13.3.3.7 KeyedBindingInitialization the default initializer must **not be
evaluated**. Yet `initCount !== 0` — either (a) `counter()` is being evaluated
eagerly (default side-effect bug), or (b) the captured `var initCount` box is
materialized only inside the conditionally-skipped default arm so later reads
corrupt to NaN (a #2692 closure-box-lazy interaction in the **param** path that
#2692's var-eager-box did not cover). Architect to pin (a) vs (b).

## Scale

`*-id-init-skipped` family across all contexts: **~96** (heavily
`statements/function/dstr/`, `for-await-of/`, class/object methods). Many use the
captured-`initCount` template, so this overlaps the closure-box correctness that
#2692 began. Est net recovery: **~40–96** (some for-await variants also gated by
#2566).

## Root-cause pointer

- `src/codegen/destructuring-params.ts` — object/array **param** default-init: is
  the default expression compiled inside the `__extern_is_undefined`/sNaN-guarded
  `then` arm, and does a captured-var box (`counter`'s `initCount`) get
  materialized only on the not-taken branch? (#2692 fixed the **body** path for
  `var`/param captures via `emitEagerCaptureBoxes`, skipping TDZ `let`/`const`;
  confirm the param-default path is covered.)
- `src/codegen/expressions/calls.ts` L12316+ (lazy capture-box) and
  `src/codegen/statements/nested-declarations.ts` (`nestedFuncCaptures`,
  `emitEagerCaptureBoxes`) — the #2692 machinery.
- `src/codegen/statements/destructuring.ts` `emitDefaultValueCheck` — confirm the
  default is only **evaluated** in the undefined arm (lazy), never eagerly.

## Acceptance criteria

- `obj-ptrn-id-init-skipped` (and the `ary-ptrn-elem-id-init-skipped` siblings)
  flip fail→pass: present falsy values (`null`/`0`/`false`/`''`) do NOT fire the
  default and `initCount === 0`.
- No regression in the #2692 closure-box / TDZ / for-await buckets.
- Guard test `tests/issue-2758.test.ts`.

## Validation

Broad closure-box surface → full `merge_group` floor + paired baseline diff
(same MANDATORY validation plan as #2692). Architect spec first.

Owner-claim released on the orphan ref (reserved only to allocate the id) — claim
fresh via `claim-issue.mjs 2758 ttraenkler/<you> --branch …`.
