---
id: 3177
title: "standalone: TypedArrayConstructors internals + ctors — integer-indexed MOP internals, ctor arg protocols, from/of, per-ctor identity (356 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: typedarray
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [2860, 2872, 2893, 2901, 3057, 3027]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; the 'TypedArray internals ~350' slice recommended by the #3027 triage"
---

# #3177 — standalone: TypedArrayConstructors internals + constructor protocols

## Problem

**356 host-pass tests are not host-free-standalone passes** under
`built-ins/TypedArrayConstructors/` (331 fail + 25 CE; measured 2026-07-12
lane-baseline diff, method in #3169). This is the "TypedArray internals ~350
— next-largest single slice" follow-on the #3027 triage recommended, distinct
from the in-flight #2872 (which owns `built-ins/TypedArray/prototype/` — do
NOT touch those paths here; coordinate with the #2872 owner on shared view
plumbing).

Breakdown: `internals/` 115 (HasProperty/Get/Set/DefineOwnProperty/Delete/
OwnPropertyKeys over integer-indexed receivers, mostly detached-buffer +
non-numeric-key arms), `ctors-bigint/` 57 + `ctors/` 53 (buffer-arg /
object-arg / length-arg constructor protocols: `custom-proto-access-throws`,
iterator-vs-arraylike, `ToIndex` on length/offset, species/newTarget proto
lookup), `from/` 35 + `of/` 18 (statics over the intrinsic ctor objects
from #2901), `prototype/` 30 + per-ctor identity rows
(`Uint16Array/prototype/constructor.js`-style
`Object.getPrototypeOf(...)`/`.constructor` asserts).

Measured signatures: `TypeError: Cannot access property on null or undefined`
(30+, the internals arms fall off the dynamic reader), `illegal cast [in
__closure_N ← assert_throws …]` (17+, throw-path closures over the view),
`Object method called on null or undefined`, destructure-null, and plain
wrong-value asserts on prototype identity.

## ANTI-BLOAT directive

- The substrate EXISTS and this slice must compose it, not fork it:
  - `$__ta_dyn_view` + runtime-kind element codec (#3057,
    `src/codegen/array-methods.ts` `emitTaDynViewToVec`) for the
    integer-indexed `[[Get]]/[[Set]]/[[HasProperty]]` arms — extend the codec
    arms with the detached-buffer + canonical-numeric-key spec steps
    (`internals/*/detached-buffer-key-is-not-number.js` etc.).
  - the distinct view brand (#2893) for receiver checks.
  - the intrinsic ctor objects + getPrototypeOf chain (#2901) for identity,
    `from`/`of` statics, and `custom-proto-access-throws` (newTarget
    `.prototype` Get must be observable/throwing).
  - descriptor arms via the builtin-descriptor MOP lineage (#2984/#2965) —
    table/arms extensions, not a parallel descriptor path.
- BigInt ctors coerce via `ToBigInt`; the 25 CE rows are compile-time
  refusals that should route into the same dynamic-view arms rather than CE.

## Acceptance criteria

- ≥240 of the 356 measured gap tests under
  `built-ins/TypedArrayConstructors/` flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/TypedArrayConstructors/internals/HasProperty/detached-buffer-key-is-not-number.js`
  - `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js`
  - `test/built-ins/TypedArrayConstructors/Uint16Array/prototype/constructor.js`
- Zero host-mode regressions; zero standalone high-water regressions; no
  edits under the `built-ins/TypedArray/prototype/`-serving method arms
  without syncing with #2872's owner.
- Horizon L: if the internals arms + ctor protocols land but `from`/`of`
  residual >50 tests remains, split a follow-on instead of one mega-PR.
