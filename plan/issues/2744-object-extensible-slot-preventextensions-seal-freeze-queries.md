---
id: 2744
title: "ES5: object [[Extensible]] internal slot — preventExtensions/seal/freeze set it; isExtensible/isSealed/isFrozen read it"
status: done
completed: 2026-06-27
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: ES5
language_feature: object-integrity
goal: spec-completeness
related: [2668]
depends_on: []
---
# #2744 — `[[Extensible]]` internal slot + integrity methods

`Object.preventExtensions`, `Object.seal`, and `Object.freeze` must flip a
per-object `[[Extensible]]` internal slot to `false` (seal/freeze additionally
make own properties non-configurable / non-writable), and
`Object.isExtensible` / `Object.isSealed` / `Object.isFrozen` must read it back.
On the current main baseline this whole cluster fails — ~55 fixable
`built-ins/Object/{preventExtensions,seal,freeze,isExtensible,isSealed,isFrozen}`
tests (mostly `assertion_fail`), with a recurring symptom of
`Object.isExtensible(obj)` returning the wrong value ("Expected obj to be
extensible, actually false" and the inverse). The root cause is the absence of a
queryable `[[Extensible]]` slot on our object representation.

## Failing test262 files (current main)

**(a) `[[Extensible]]` slot + `isExtensible`:**
- `test/built-ins/Object/isExtensible/15.2.3.13-2-1.js`
- `test/built-ins/Object/preventExtensions/15.2.3.10-3-8.js`,
  `…/preventExtensions/15.2.3.10-3-23.js`, `…/preventExtensions/15.2.3.10-3-5.js`
- `test/built-ins/Object/seal/object-seal-the-extension-of-o-is-prevented-already.js`
- `test/built-ins/Object/seal/object-seal-non-enumerable-own-property-of-o-is-sealed.js`
- `test/built-ins/Object/seal/object-seal-p-is-own-accessor-property.js`
- `test/built-ins/Object/seal/object-seal-o-is-an-array-object.js`
- `test/built-ins/Object/seal/object-seal-all-own-properties-of-o-are-already-non-configurable.js`
  ("Expected obj to be extensible, actually false")

**(b) `seal` → non-configurable own props; `isSealed`:**
- `test/built-ins/Object/seal/object-seal-o-is-frozen-already.js`
- `test/built-ins/Object/seal/object-seal-inherited-accessor-properties-are-ignored.js`
- `test/built-ins/Object/isSealed/15.2.3.11-4-26.js`

**(c) `freeze` → non-writable + non-configurable; `isFrozen`:**
- `test/built-ins/Object/freeze/15.2.3.9-2-c-3.js`, `…/freeze/15.2.3.9-2-c-4.js`
  (currently throw `TypeError: Cannot assign to read only property` instead of
  silently no-op in sloppy mode)
- `test/built-ins/Object/freeze/15.2.3.9-2-3.js`,
  `…/freeze/abrupt-completion.js`
- `test/built-ins/Object/isFrozen/15.2.3.12-2-1.js`,
  `…/isFrozen/15.2.3.12-2-c-2.js`, `…/isFrozen/15.2.3.12-2-a-14.js`

## Acceptance criteria

- A per-object `[[Extensible]]` slot exists and is queryable: after
  `Object.preventExtensions(o)`, `Object.isExtensible(o) === false`; a fresh
  object is `isExtensible === true`.
- `Object.seal(o)` sets `[[Extensible]] = false` AND makes every own property
  non-configurable; `Object.isSealed(o) === true`.
- `Object.freeze(o)` additionally makes data properties non-writable;
  `Object.isFrozen(o) === true`; a sloppy-mode write to a frozen property is a
  silent no-op (no thrown `TypeError`).
- **Target: ≥45 of the ~55 fixable integrity tests fixed** across the six
  methods. No regression in currently-green Object tests.

## Notes
- Spec: ES2023 §10.1.3-4 `[[PreventExtensions]]`/`[[IsExtensible]]`; §20.1.2.20
  `Object.preventExtensions`, §20.1.2.22 `Object.seal`, §20.1.2.6
  `Object.freeze`, §20.1.2.14/15/19 the `is*` queries; `SetIntegrityLevel` /
  `TestIntegrityLevel` §7.3.15-16.
- Interacts with #2668 (descriptor fidelity): seal/freeze flip
  `configurable`/`writable` descriptor attributes, so coordinate the descriptor
  representation with the #2668 senior-dev. The `[[Extensible]]` slot itself is
  orthogonal to descriptor read-back and can land independently.
- `seal-finalizationregistry.js` (FinalizationRegistry) and Proxy-handler seal
  tests are out of scope (blocked clusters).

## Test Results (esch, 2026-06-27) — Slice 1: routing + slot + TestIntegrityLevel

Implemented the architect's Slice-1 (routing + `[[Extensible]]` slot, the
independent unit). Measured on `built-ins/Object/{isExtensible,isFrozen,isSealed,
preventExtensions,seal,freeze}` (317 tests) via the real `wrapTest`+runner:

- **baseline (origin/main): 252 pass / 65 fail → with fix: 281 pass / 36 fail**
  = **+29 fixed, ZERO regressions** (verified by fail-set diff).

Changes:
- `src/codegen/expressions/calls.ts` — the integrity codegen treated any
  non-`externref` argType as a primitive (folding `isExtensible`→0 /
  `isFrozen`,`isSealed`→1 for arrays/typed-structs/Date). Now an `isObjectRef`
  predicate routes EVERY object ref through the runtime via **raw
  `extern.convert_any`** (NOT `coerceType`, which appends `__make_iterable` and
  materializes a vec into a *fresh* JS array per call → identity loss). Dropped the
  order-blind host-mode static fold for the queries (fixes the
  `isExtensible`-pre-check-before-`seal` failures). Generalized the freeze/seal/
  preventExtensions SET coercion from standalone-only to ALL modes.
- `src/runtime.ts` — reimplemented `__object_isFrozen`/`__object_isSealed` as
  WeakSet fast-path **OR** `_testIntegrityLevel` (§7.3.16) over the live descriptor
  table (`_getSidecarDescs` + canonical `_ownStructKeys`), so `preventExtensions` +
  `defineProperty(non-writable/non-config)` (data AND accessor) reports `isFrozen`.

Remaining (deferred follow-ons, #2668-coupled, per the architect's sequencing):
group (c) sloppy frozen-write strict-gate (the `freeze/15.2.3.9-2-c-*` propertyHelper
tests trap deeper than the write-throw), the global-object sub-case (overlaps #2726),
and the `propertyHelper.js`/descriptor-precision cluster. Out of scope: Proxy-handler,
FinalizationRegistry, `not-a-constructor` harness CEs, resizable-buffer TypedArray.

## Implementation Plan (architect: esch, 2026-06-27) — dev-implementable

**VERIFIED on current `origin/main` HEAD via `compile()`+run probes and the real
`runTest262File` runner.** The runtime machinery already EXISTS and is correct for
`$Object`/externref receivers (`_wasmNonExtensibleObjs`/`_wasmFrozenObjs`/
`_wasmSealedObjs` WeakSets at `src/runtime.ts:1436-1437` + `_getSidecarDescs`). The
failures are a **codegen routing bug** + a **query-correctness gap**, not a missing
slot. The issue's "absence of a queryable slot" framing is half-right: the slot
exists for `$Object` but is never *reached* for `ref`-typed object receivers.

### Root cause (verified)

The integrity codegen (`src/codegen/expressions/calls.ts:5709-5893`) treats **any
non-`externref` `argType` as a primitive**. An array (vec `ref`), a typed object
literal struct (`ref`), and a typed `Date` (`ref`) are OBJECTS but compile to
`ref`/`ref_null`, so the `else if (argType)` arms mis-fire:
- `isExtensible` (`:5883-5888`) → folds to `i32.const 0` → **wrong (false)**.
- `isFrozen`/`isSealed` (`:5841-5846`) → folds to `i32.const 1` → **wrong (true)**.
- `freeze`/`seal`/`preventExtensions` (`:5797-5798`) → returns the arg as-is,
  relying ONLY on order-blind compile-time `nonExtensibleVars`/`frozenVars`/
  `sealedVars` keyed on the identifier — so the runtime WeakSet is never populated
  for `ref` receivers, and a `var pre = Object.isExtensible(arr)` *pre-check* before
  `Object.seal(arr)` reads stale (the tracking set isn't populated until the later
  `seal` call is compiled).

Probe evidence (host mode, current main):
`Object.isExtensible([0,1])` → `0` (must be 1); `Object.isExtensible({x:1,y:2})`
(typed struct) → `0` (must be 1); `Object.isExtensible(o)` for `o:any` (`$Object`)
→ correct. So ONLY the `ref`-typed object path is broken; `any`/`$Object` works.

A second, independent gap: `__object_isFrozen`/`__object_isSealed`
(`runtime.ts:8432/8443`) answer via `_wasmFrozenObjs.has(obj)` /
`_wasmSealedObjs.has(obj)` — i.e. "was `Object.freeze/seal` *called*", NOT
TestIntegrityLevel (§7.3.16) over the live descriptor table. So
`Object.preventExtensions(o)` on an object with a configurable accessor returns the
wrong `isFrozen` (must be false; `built-ins/Object/isFrozen/15.2.3.12-2-c-2.js`), and
a manually-non-configurable-but-never-sealed object misreports.

### Changes

**File: `src/codegen/expressions/calls.ts`** (the four integrity sites, 5709-5893)
- Add a local predicate `isObjectRef(t)` = `t.kind` is `ref`/`ref_null`/`anyref`/
  `eqref`/`externref` (an object), NOT a primitive (`f64`/`i32`/`i64`/`v128`/`funcref`).
- **`isExtensible`/`isFrozen`/`isSealed` general case:** replace the
  `else if (argType)` primitive-fold with: **if `isObjectRef(argType)` and not
  already externref → `extern.convert_any` to externref**, then call the runtime
  `__object_is*` helper (the existing externref arm). Fold to the primitive answer
  (`isExtensible`→0, `isFrozen`/`isSealed`→1) ONLY for genuine primitives. This is
  the same `extern.convert_any` coercion the freeze SET path already does for
  standalone at `:5766-5773` — generalize it to all modes AND to the query path.
- **`freeze`/`seal`/`preventExtensions` (`:5766-5798`):** generalize the
  standalone-only coercion to ALL modes — when `isObjectRef(argType)` and not
  externref, `extern.convert_any` and call the `__object_*` SET helper so the
  WeakSet/descriptor state is recorded for vec/struct/Date receivers (not just
  `$Object`). Keep the compile-time `markIntegrity` var-marking as an ADDITIONAL
  fast-path for the strict-mode write-throw decision (below), but it must no longer
  be the *only* effect for `ref` receivers.
- **Retire the host-mode static fold as the source of truth for queries.** The
  `nonExtensibleVars`/`frozenVars` const-folds (`:5818-5828`, `:5866-5871`) are
  execution-order-blind (the #1472 comments already say so) and produce the
  pre-check-before-seal bug. Now that the runtime query is authoritative for object
  refs, **drop these host-mode static folds** (standalone already skips them) so the
  pre-check reads live runtime state. This fixes every `assert(Object.isExtensible(o))`
  / `preCheck` failure in the seal/preventExtensions tests.

**File: `src/runtime.ts`** — reimplement the queries as TestIntegrityLevel (§7.3.16)
- `__object_isSealed` (`:8443`) and `__object_isFrozen` (`:8432`): for a wasm
  struct/vec receiver, compute from OUR representation — `level = sealed`:
  `_wasmNonExtensibleObjs.has(obj)` AND for EVERY own key (struct field shape via
  `_getStructFieldNames` + sidecar props in `_wasmStructProps`) the descriptor in
  `_getSidecarDescs(obj)` has `configurable === false`; `level = frozen` additionally
  requires `writable === false` for every data property. Do NOT fall through to
  native `Object.isFrozen/isSealed` for a wasm struct/vec (it sees an opaque
  null-proto proxy and lies). Keep the `_wasmFrozenObjs`/`_wasmSealedObjs` add in the
  SET helpers as a fast-path cache, but the QUERY must verify the live descriptor
  table so post-`freeze` manual reconfigurations and `preventExtensions`+configurable
  cases answer correctly.
- Ensure the SET helpers' `_isWasmStruct(obj)` gate (`:8354/8384/8413`) ALSO covers
  the **vec/array** representation. Verify `_isWasmStruct([...])` is true for a vec;
  if arrays are a distinct vec struct that `_isWasmStruct` rejects, broaden the gate
  (or add a vec arm) so `Object.seal(arr)`/`isSealed(arr)` don't fall to native
  `Object.*` on a vec proxy (`built-ins/Object/seal/object-seal-o-is-an-array-object.js`).

### Edge cases / sub-cases
- **Group (c) — sloppy frozen write must be a SILENT no-op.** A plain `o.a = v`
  assignment to a frozen data property currently throws `TypeError: Cannot assign to
  read only property` unconditionally (`built-ins/Object/freeze/15.2.3.9-2-c-3.js`).
  Per §13.15.2 / PutValue, a write to a non-writable property is a **silent no-op in
  sloppy mode** and throws **only under `"use strict"`**. test262 defaults to sloppy.
  The frozen-write throw is in the `needsValueCompare`/`isFrozenProperty` path
  (`src/codegen/object-ops.ts:2202-2240`) AND the plain member-assign equivalent —
  gate the throw on the function's strict-mode flag (reuse
  `isStrictFunction(...)` / the same strictness the rest of codegen consults).
  Keep the strict-mode throw (other tests assert it).
- **Global object — OUT OF PRIMARY SCOPE (1-2 tests).** `var global = this;
  Object.isExtensible(global)` must be true (`isExtensible/15.2.3.13-2-1.js`); the
  top-level `this`/global is not a queryable object in our model → returns 0. This
  OVERLAPS **#2726** (sloppy global-object model). Note it; do not block the ≥45
  target on it.
- **Date / built-in exotics:** once `ref` object receivers route to the runtime,
  `Object.isExtensible(new Date(0))` returns true (verified for an `any`-typed Date).
  Confirm the typed-`Date` `ref` path coerces and that `_isWasmStruct(date)` (or the
  Date representation) is recognized by the SET/IS helpers.
- The compile-time `frozenVars`/`nonExtensibleVars` tracking REMAINS only for the
  strict-mode write-throw decision; it is no longer authoritative for queries.

### Coordination with #2668 (REQUIRED, but the slot is independent)
seal/freeze flip `configurable`/`writable` in `_getSidecarDescs` (the `_SC_*` bits).
The new TestIntegrityLevel reader READS those same bits #2668's
`getOwnPropertyDescriptor` read-back writes/reads — **align the `_SC_WRITABLE`/
`_SC_CONFIGURABLE`/`_SC_ENUMERABLE`/`_SC_DEFINED` semantics with the #2668 senior-dev**
so seal/freeze and descriptor read-back agree. BUT the **`[[Extensible]]` slot +
the coerce-object-ref-to-runtime routing is ORTHOGONAL** (per the issue note) and
should land FIRST — it banks the large array/struct `isExtensible`/`isSealed` cluster
on its own. The TestIntegrityLevel descriptor-precision can co-develop with #2668.

### Verdict
**Dev-implementable** (regular dev). The routing fix (coerce object refs → runtime)
is the high-value bulk (~40+ of the ~55: every array/typed-struct/Date `is*` + the
pre-check failures). The TestIntegrityLevel reimpl is localized to two runtime
functions. Strict-mode sloppy-write (group c) and the global object are smaller
follow-ons. No new object representation. Sequence: routing+drop-static-fold first,
then TestIntegrityLevel (coordinate `_SC_*` with #2668), then group (c) strict-gate.

### Test files (authoritative runner reasons, current main)
- `isExtensible/15.2.3.13-2-1.js` → `assert(isExtensible(global))` (global sub-case)
- `preventExtensions/15.2.3.10-3-8.js` → `assert(isExtensible(new Date(0)))` pre-check
- `seal/object-seal-o-is-an-array-object.js` → array pre-check (vec ref → false)
- `seal/object-seal-non-enumerable-own-property-of-o-is-sealed.js` → obj pre-check
- `isFrozen/15.2.3.12-2-c-2.js` → preventExtensions+configurable accessor → isFrozen
  must be false (TestIntegrityLevel)
- `isSealed/15.2.3.11-4-26.js`, `isFrozen/15.2.3.12-2-1.js` → query correctness
- `freeze/15.2.3.9-2-c-3.js` → sloppy frozen write must NOT throw (group c)
- Regression watch: `built-ins/Object/{freeze,seal,preventExtensions,is*}` already green.
