---
id: 2758
title: "Object/array-pattern default-init side-effect runs when element is present (init-skipped) — call default eagerly evaluated / closure-box in skipped arm"
status: done
assignee: ttraenkler/dstr758
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
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
sprint: 69
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

## Root-cause (verified)

**Diagnosis: (b) — the captured-var box, NOT eager default evaluation.** Verified
on `origin/main` @ `0a67b9a` by running the real runner
(`runTest262File` on `obj-ptrn-id-init-skipped.js`) → `fail` on baseline,
`pass` with the fix; and by WAT inspection.

The test262 runner wraps the whole test body in `export function test()`, so
`var initCount`, `function counter()` (which does `initCount += 1`) and
`function f({ w = counter(), … })` all become **nested** in `test()`.
`counter` mutably captures `initCount`; `f` ALSO captures `initCount` (its body
reads it in `assert.sameValue(initCount, 0)`) **and** calls `counter` in its
parameter defaults.

`f`'s capture of `initCount` is by-VALUE (`f64` leading param) — `f`'s body never
*directly* writes it. But because `f` calls `counter` (which mutates it), the
call-site **lazy capture-box** machinery (`calls.ts` `nestedFuncCaptures`
mutable branch, ~L12904) wraps `initCount` in a `struct (field (mut f64))` ref
cell, stores it in a `$__boxed_initCount` local, and re-aims **all** of `f`'s
reads of `initCount` to `struct.get` on that box. The box's `struct.new` /
`local.tee` was emitted into **whatever body buffer was active at the first
capturing call site** — and that first call site is `w = counter()`, inside the
default's `__extern_is_undefined`-guarded `then`-arm.

When the property is PRESENT (`null`/`0`/`false`/`''`), §13.3.3.7 step 6 means
the default is correctly skipped — the `then`-arm does not run — so the box is
**never created**. `f`'s later read `local.get $__boxed_initCount` finds it
**null**, and the null-box read lowers to the sNaN sentinel
(`i64.const 9218868440963334366; f64.reinterpret_i64`) → `initCount` reads NaN
(WAT `$f` tail, the `if (result f64) (then <sNaN>) (else struct.get)`). The
bindings (`w === null`, …) are correct — so asserts #1–#4 pass and only assert
#5 (`initCount === 0`) fails, exactly as observed. The default call is **not**
evaluated eagerly; `counter` never runs.

This is the same class of bug #2692 fixed for the **declaring** scope
(`emitEagerCaptureBoxes`), but in the **caller** scope: #2692 eagerly boxes vars
captured by functions *declared* here; it does not cover a function that merely
*calls* a sibling whose mutable capture it shares.

## Fix

`src/codegen/statements/nested-declarations.ts` — new
`emitEagerNestedCallCaptureBoxes`, called in `compileNestedFunctionDeclaration`'s
has-captures branch **before** `emitDefaultParamInit` / `destructureParamObject`.
For each by-VALUE capture of the function that a referenced sibling (scanned in
the body **and** the parameter default initializers) *mutably* captures, it
materializes the ref-cell box at the unconditional function-top (mirroring
#2692). The later default-arm call then takes its already-boxed branch (no second
`struct.new`), and the body read derefs a live box holding the by-value capture's
entry value. Same `__boxed_<name>` + lockstep `boxedCaptures`/`localMap`
convention. Narrowing matches #2692: skips `mutable` (already a box param),
`alreadyBoxed` (outer cell threaded through), and `hasTdzFlag` (`let`/`const`
— eager-boxing races their block-scoped re-decl, the for-await regression
rationale). `var`/param by-value captures only — exactly the captured-counter
template.

## Test Results (scoped, fix ON vs OFF on current main)

- Real `obj-ptrn-id-init-skipped.js` via `runTest262File`: OFF=`fail`, ON=`pass`.
- All 276 `*-init-skipped` (language/): OFF pass=180, **ON pass=222 (+42)**, no
  new compile errors (ce=2 both).
- for-await/for-of dstr `init`/`dflt` (677): OFF pass=415, **ON pass=439 (+24)**,
  no regressions.
- Non-skipped `-id-init` (defaults FIRE, 276): unchanged 271/271 both — no
  regression.
- Local vitest: `issue-2692-closure-box-eager`, `issue-2669`, `issue-1128-dstr-tdz`,
  `issue-2158`, `issue-2512`, `issue-2545`, `issue-2567`, `issue-2568` all green;
  pre-existing harness-import `LinkError`s in `illegal-cast-closures-585` and the
  destructuring/generator batch are identical OFF and ON (not regressions).
- New guard `tests/issue-2758.test.ts` — 3 cases green.
