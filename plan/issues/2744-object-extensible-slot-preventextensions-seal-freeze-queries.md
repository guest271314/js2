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
