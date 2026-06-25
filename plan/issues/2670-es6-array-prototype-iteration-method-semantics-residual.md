---
id: 2670
title: "ES2015: Array.prototype iteration-method semantics residual (~1017 fails — generic array-like receiver, callback/thisArg, holes, length coercion)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-methods
goal: spec-completeness
related: [2177, 2151, 473, 2580]
sprint: 66
---
# #2670 — ES2015 Array.prototype iteration-method semantics residual

## Edition / impact

- **Edition:** ES2015 (the bulk of `built-ins/Array/prototype` fails; pre-ES6
  Array methods overlap ES5 too).
- **Fail count:** **~1017** `built-ins/Array/prototype/*` — the single largest
  built-in cluster in the suite.
- By method: reduce 144, reduceRight 129, map 80, every 68, some 67, forEach 63,
  splice 61, filter 60, lastIndexOf 57, indexOf 55, slice 54, concat 38,
  sort 36, plus pop/push/join/shift/unshift/copyWithin/reverse tails.
- Residual after #2177 (Array.prototype.<m>.call on $Vec/open-object receiver,
  done) and #2151 (any-receiver dispatch, done). Those fixed the dispatch
  plumbing; the spec-algorithm fidelity tail remains.

## Problem

The Array iteration methods are spec'd as **generic** over an array-*like*
receiver (`ToObject(this)` + `ToLength(this.length)` + indexed `[[Get]]`/`[[Set]]`),
not just real arrays. The failing tests overwhelmingly call them via
`Array.prototype.<m>.call(arrayLikeObject, ...)` where the receiver is a plain
object with a numeric `length`, a string, or a sparse/hole-bearing array. The
recurring spec requirements not yet met:

1. **Generic array-like receiver** — `reduce.call({0:'a',1:'b',length:2}, cb)`
   must read `length` (via `ToLength`) and elements `0..length-1` via `[[Get]]`
   on the dynamic object, not assume a compiled `$Vec`. Dominant signature:
   `assert.sameValue(Array.prototype.reduce.call(obj, ...), ...)`.
2. **`length` coercion** — `ToLength(this.length)` (clamp, `ToInteger`,
   non-array length, getter side effects, accessed exactly the spec number of
   times). Ties to open #2580 (`.length` on any/dynamic receiver returns 0).
3. **Holes** — absent indices skipped by forEach/map/every/some/filter/reduce;
   present-vs-absent probed via `HasProperty`. Signature
   `assert(accessed, ...)`.
4. **Callback contract** — `callbackfn(value, index, O)`, `thisArg` binding,
   `TypeError` when callback not callable, `reduce`/`reduceRight` `TypeError`
   on empty array with no initial value, traversal order/direction.
5. **Mutation during iteration** — length captured up front; elements added
   during the callback not visited.

## Failing-test cluster (examples)

```
built-ins/Array/prototype/reduce/15.4.4.21-9-c-ii-29.js   (.call(obj,...) array-like)
built-ins/Array/prototype/reduce/15.4.4.21-8-b-ii-2.js     (empty + no init → TypeError)
built-ins/Array/prototype/every/15.4.4.16-7-c-ii-*.js      (holes / array-like)
built-ins/Array/prototype/map/15.4.4.19-8-c-ii-*.js
built-ins/Array/prototype/filter/15.4.4.20-9-c-ii-*.js
```

## Acceptance criteria

- Target: pass **≥ 700 of ~1017** `built-ins/Array/prototype/*` failing tests.
- Iteration methods operate on a **generic array-like** receiver (object with
  `length`, string) via `ToObject`/`ToLength`/`[[Get]]`, not only `$Vec`.
- Holes skipped; `length` coerced with `ToLength` and read the spec number of
  times; callback receives `(value, index, O)` with `thisArg`.
- `reduce`/`reduceRight` throw `TypeError` on empty + no initial value;
  non-callable callback throws `TypeError`.
- No regression in currently-passing Array tests.

## Notes — feasibility: hard

Core array-builtin machinery; route to architect for a spec before dispatch.
The high-leverage fix is a **shared generic element-access path** (ToObject +
ToLength + HasProperty + Get/Set over a dynamic receiver) that all iteration
methods route through, replacing $Vec-only fast paths when the receiver is not a
compiled array. Coordinate with #2580 (length on dynamic receiver). Slice by
method family (reduce/reduceRight; map/filter/forEach/every/some; index-of;
slice/splice/concat) so each lands independently.
