---
id: 2761
title: "Set set-algebra set-like-arg residual: class-instance set-likes (substrate-gated), set-like-array, iterator-return (27 test262 fails)"
status: done
assignee: ttraenkler/dev-f
completed: 2026-07-17
created: 2026-06-28
updated: 2026-07-17
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: runtime
language_feature: set
goal: spec-completeness
sprint: Backlog
related: [1627, 2681, 2686]
parent: 1627
# (#3102) runtime.ts is a god-file at ceiling; the B/C fix adds a small
# vec-sidecar-copy helper + keys() iterator bridge to the host set-algebra path.
loc-budget-allow:
  - src/runtime.ts
---

## Resolution (2026-07-17)

Sub-causes **B (set-like-array, 7)** and **C (set-like-iter-return, 2)** — the
independently-tractable residual — are fixed (9 test262 fail→pass), verified on
the host/JS-host gc lane. Sub-cause **A (class-instance set-likes, 18)** stays
**folded into the value-rep / proto-read substrate roadmap** (`related: 2681,
2686`) per the acceptance criteria — it is architect-scoped and NOT point-fixed
here; it flips once that substrate lands.

- **B fix** (`src/runtime.ts`): `__make_iterable`'s `convertToJS` materialized a
  vec into a plain `new Array(len)` holding only the ELEMENTS, dropping the
  dynamic `size`/`has`/`keys` sidecar props, so native `GetSetRecord` read
  `size = undefined → NaN`. New `_copyVecSidecarOntoArray` surfaces the vec's
  non-index own sidecar props onto the materialized array (closure values
  host-callable-wrapped). Free for ordinary arrays (no sidecar → early return).
- **C fix** (`src/runtime.ts`): the object set-like's `keys()` returned a
  compiled `{ next(){…}, return(){…} }` iterator whose methods are opaque
  wasm-closure struct fields ("string 'next' is not a function"). Routed the
  keys() RESULT through the existing `_iteratorRecordForHost` shim (bridges
  next/return/throw callable, host-mirrors struct step results) in
  `_setLikeRecordForHost`.

Guard: `tests/issue-1627.test.ts` extended with the B and C case batteries.

# #2761 — Set set-algebra set-like-arg residual (carried over from #1627)

## Origin

#1627 fixed the **object-literal** set-like-argument cases for the 7 Set
set-algebra methods (`union` / `intersection` / `difference` /
`symmetricDifference` / `isSubsetOf` / `isSupersetOf` / `isDisjointFrom`) by
adding a GetSetRecord-faithful host adapter (`_setLikeRecordForHost` +
`_resolveHostField` in `src/runtime.ts`): the host `_wrapForHost` proxy masked
every WasmGC-struct field as a callable, defeating native V8's
`GetSetRecord(other)` `IsCallable`/`ToNumber` validation. That landed
**built-ins/Set 328 → 346 / 383 (≈90.3 %)**.

This issue tracks the **27 remaining** `built-ins/Set/prototype` set-like-arg
fails, which have three distinct root causes the #1627 adapter cannot supply
(each verified via `runTest262File` on the host/JS-host gc lane).

## Sub-cause A — class-instance set-likes (18) **[SUBSTRATE-GATED / architect-scoped]**

```
{union,intersection,difference,symmetricDifference,isSubsetOf,isSupersetOf,isDisjointFrom}/allows-set-like-class.js   (7)
{union,intersection,difference,symmetricDifference,isSubsetOf,isSupersetOf,isDisjointFrom}/set-like-class-order.js     (7)
{union,intersection,difference,symmetricDifference}/set-like-class-mutation.js                                        (4)
```

A set-like built as `new class { get size(){…} has(){…} *keys(){…} }` reaches
the host as an opaque WasmGC struct whose getter/methods live on the (anonymous
class) **prototype**. `_resolveHostField` returns `undefined` for all of
`size`/`has`/`keys` → native GetSetRecord reads `size = undefined` → `NaN` →
throws TypeError, so a _valid_ set-like is rejected.

**This is the SAME value-rep substrate theme as the acorn cluster #2681 / #2686**
(`$Object` / dynamic reader loses native struct / prototype identity): the host
cannot resolve an anonymous-class-instance's prototype members off the opaque
struct. It should be folded into the value-rep / IR substrate roadmap and is
**architect-scoped** — do NOT attempt a point fix in the Set adapter; the same
gap recurs across every host consumer that reads members off a class-instance
struct. Gate this sub-cause behind the proto-read / value-rep substrate work.

## Sub-cause B — set-like-array (7) **[possibly independently tractable]**

```
{union,intersection,difference,symmetricDifference,isSubsetOf,isSupersetOf,isDisjointFrom}/set-like-array.js  (7)
```

`const s2 = [5,6]; s2.size = 3; s2.has = fn; s2.keys = fn;` — an array consumed
as a set-like, not as an array. The dynamically-added `size`/`has`/`keys` props
do not resolve through the struct/sidecar path `_resolveHostField` uses for a vec
backing, so `size` reads as NaN. May be fixable independently of the substrate
work by routing array dynamic-prop reads through the same sidecar lookup; worth a
verify-first probe before assuming substrate-gated.

## Sub-cause C — iterator-return (2) **[possibly independently tractable]**

```
isSupersetOf/set-like-iter-return.js
isDisjointFrom/set-like-iter-return.js
```

`string "next" is not a function` — the `keys()` iterator's `return()` close
protocol (IteratorClose on early exit) isn't bridged for the wasm-returned
iterator. Likely independent of A/B; relates to the broader IteratorClose theme
(#1642).

## Acceptance criteria

- Sub-cause B and C verify-first probed; if independently tractable, flip their
  9 tests fail→pass with no regression in `built-ins/Set`.
- Sub-cause A folded into the value-rep / proto-read substrate roadmap (tracked,
  not point-fixed); flips the 18 class-instance fails once that substrate lands.
- No regression in currently-passing `built-ins/Set` tests (host gc lane).

## Notes

- Guard from #1627: `tests/issue-1627.test.ts` (27 tests). Extend it as B/C land.
- Host adapter entry points to reuse: `_setLikeRecordForHost` /
  `_resolveHostField` in `src/runtime.ts` (the 7 set-algebra methods' bridge).
