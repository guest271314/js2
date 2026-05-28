---
id: 1691
title: "yield* does not delegate throw()/return() to the inner iterator (eager-generator model gap)"
status: blocked
created: 2026-05-27
updated: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1665
blocked_on: [1665, 1042]
escalation: "[ESCALATED-NEEDS-ARCHITECT] 2026-05-28 — senior-dev re-confirmed there is no localized fix. Routing to architect to fold into the lazy-generator design (#1665) and CPS lowering (#1042). See ## Senior-dev re-confirmation (2026-05-28)."
---
# #1691 — yield* does not delegate throw()/return() to the inner iterator

## Problem

`yield* <iterable>` correctly forwards `next()` values but does **not** forward
the outer generator's `throw()` / `return()` into the delegated iterator, as
required by ECMAScript §14.4.14 (YieldExpression : `yield * AssignmentExpression`,
the `received.[[Type]] is throw` / `is return` branches).

13 test262 cases in `language/expressions/yield` fail on this — the entire
`star-rhs-iter-thrw-*` family plus `star-rhs-iter-thrw-violation-*`:

- `star-rhs-iter-thrw-thrw-invoke.js` — asserts the delegate's `throw` method
  is invoked with the thrown value; compiler returns wrong sentinel (observed 7777).
- `star-rhs-iter-thrw-res-value-final.js` — observed 2222 instead of delegated value.
- `star-rhs-iter-thrw-res-done-err.js`, `-res-done-no-value.js`,
  `-res-value-err.js`, `-thrw-call-err.js`, `-thrw-call-non-obj.js`,
  `-thrw-get-err.js`, `-violation-no-rtrn.js`, `-violation-rtrn-call-err.js`,
  `-violation-rtrn-call-non-obj.js`, `-violation-rtrn-get-err.js`,
  `-violation-rtrn-invoke.js`.

The sibling `return()` delegation (`star-rhs-iter-rtrn-*`) compiles but does not
exercise true lazy delegation either; it currently passes only because the eager
model happens to drain to completion for the simple shapes.

## Root cause

The compiler uses an **eager generator model**. `compileYieldExpression`
(`src/codegen/expressions/misc.ts:177`, the `expr.asteriskToken` branch) lowers
`yield* x` to a call to `__gen_yield_star(buffer, iterable)`.

`__gen_yield_star` (`src/runtime.ts:5692`) is:

```js
(buf, iterable) => {
  if (iterable != null && typeof iterable[Symbol.iterator] === "function") {
    for (const v of iterable) { buf.push(v); }   // next() only
  }
};
```

It drains the inner iterator via a plain `for...of` (calling **only** `next()`)
and pushes every value into the outer generator's buffer eagerly. By the time
user code calls `outerGen.throw(e)` or `outerGen.return(v)`, the inner iterator
has already been fully consumed and discarded — there is no live delegate to
forward the completion to. So the §14.4.14 step-5.b (`throw`) and step-5.c
(`return`) branches are unobservable.

## Why this is hard (feasibility: hard)

Correct `yield*` throw/return delegation requires the generator to **suspend**
at the `yield*` point holding a reference to the live inner iterator, so a later
`throw()`/`return()` on the outer generator can be routed to the delegate's
corresponding method. That is exactly the lazy / re-entrant generator semantics
the eager-buffer model was designed to avoid.

This should be folded into the lazy-generator / CPS work, not patched in the
eager runtime:
- #1665 (native generators — shared `$Iterator` design gap)
- #1373 / #1042 (IR async + CPS lowering — the suspend/resume machinery)

A localized patch to `__gen_yield_star` cannot satisfy the protocol because the
suspension point does not exist in the eager model.

## Acceptance criteria

- `yield*` suspends at the delegation point and forwards `throw()`/`return()` to
  the inner iterator per §14.4.14 steps 5.b / 5.c.
- The 13 `star-rhs-iter-thrw-*` test262 cases pass.
- `star-rhs-iter-rtrn-*` continue to pass under the lazy model.

## Investigation notes (2026-05-27)

Probe of all 63 `language/expressions/yield` tests (proper host imports via
`buildImports` + `wrapTest`): 45 PASS + 3 PASS(negative-CE) = 48 passing; 13
fail on the throw-delegation gap above; 2 are TS-strictness CE artifacts in the
test source (`star-return-is-null.js`, `star-rhs-iter-rtrn-rtrn-invoke.js` —
`'this' implicitly has type 'any'` / iterator-shape typing, not genuine JS parse
failures — out of scope for this issue).

## Related

- Blocks-on: #1665, #1373, #1042 (lazy/CPS generator model)
- Sibling investigation: #820c (async-gen object-method yield* null deref)

## Senior-dev re-confirmation (2026-05-28)

Re-validated the analysis against current main (`e3c53820e`). Findings unchanged:

- `src/codegen/expressions/misc.ts:177-202` still lowers `yield* x` to a single
  `__gen_yield_star(buf, iterable)` call followed by a `ref.null.extern` result.
  The inner iterable is **consumed in full inside the generator function body**,
  before the outer generator object even exists.
- `src/runtime.ts:6556-6581` (`__create_generator`) confirms the generator
  instance is just `{ buf, index, pendingThrow }` with no reference to any live
  inner iterator and no suspension point. `next()` / `throw()` / `return()`
  (via `_getGeneratorInstancePrototype()`) all walk the same flat buffer.
- `__gen_yield_star` (`runtime.ts:5692`) drains via `for...of`, calling **only**
  `next()`. By the time `outerGen.throw(e)` is invoked, the inner iterator is
  already finalized and unreferenced.

**Why no incremental "throw-replay" hack works either**: even if we recorded
each visited inner iterable on the generator state so that a later
`outerGen.throw(e)` could re-resolve and call `innerIter.throw(e)`, the spec
(§14.4.14 step 5.b.iii) requires the *delegated* `throw` result to be re-yielded
to the **caller** of `outerGen.throw` — which in our model is the very loop
that already finished. The required interleaving (`outerGen.next() → first
inner yield → outerGen.throw(e) → forwarded to inner.throw → next inner yield`)
needs the outer body to be **suspended mid-`yield*`**. That suspension point
does not exist in the eager generator model; producing it is exactly what
#1665 (native `$Iterator` design) and #1042 (CPS state-machine lowering) are
chartered to introduce.

**Architect decision needed** (route to architect, fold into #1665 spec):

1. Will lazy `yield*` ride on the #1042 CPS state machine (treating each `yield`
   / `yield*` as a CPS suspension point with a `[[BoundIterator]]` slot that
   `throw`/`return` route through), or will generators get their own narrower
   "iterator-coroutine" representation (cheaper than full CPS)?
2. If we keep eager generators as the default and only switch to lazy when the
   compiler detects `yield*` (or any feature that requires re-entry), what's
   the dispatch boundary — per-function, per-call-site, or runtime-flagged?
3. Test262 acceptance criteria (the 13 `star-rhs-iter-thrw-*` cases) require
   spec-compliant `IteratorClose` ordering when `throw` is forwarded but the
   inner iterator has no `throw` method — the architect spec should pin which
   §7.4.* algorithm steps are in scope vs deferred.

No code changes landed on this branch — only the issue-file status flip and
this note. The implementation belongs to the umbrella lazy-generator work
once #1665 has an architect spec.
