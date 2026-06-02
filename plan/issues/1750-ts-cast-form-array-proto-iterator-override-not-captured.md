---
id: 1750
title: "TS-cast form `(Array.prototype as any)[Symbol.iterator] = fn` not captured by CPR write-arm"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: low
feasibility: medium
task_type: feature
area: codegen, runtime
language_feature: array-object-identity, iterator-protocol, type-assertion
goal: object-representation
sprint: Backlog
parent: 1719
related: [1719]
---
# #1750 — CPR write-arm must capture the TS-cast assignment form

## Problem

Split out of #1719 (CPR). The CPR write-arm
(`maybeCaptureArrayProtoOverride`, `src/codegen/expressions/proto-override.ts`)
captures `Array.prototype[Symbol.iterator] = fn` and `Array.prototype.values = fn`
into a rooted module global so destructuring can drive the override. It does NOT
capture the **TypeScript cast form**:

```ts
(Array.prototype as any)[Symbol.iterator] = function*(){ yield 42 };
```

Here the assignment target is a `ParenthesizedExpression` wrapping an
`AsExpression`, not a bare `ElementAccessExpression` on `Array.prototype`. The
write-arm's target-shape match does not see through the cast wrapper, so the
override is dropped at compile time (the S2 "assignment evaporates" path), and a
subsequent destructure reads the backing store (`z === 3`, not `42`).

## History — why a naive wrapper-strip was reverted

A first attempt widened the target match to strip the `as`/paren wrapper. It made
the write-arm **capture** the override, but the read-drive then trapped
("Cannot read properties of null"): the cast-form generator closure was not
resolved by the arity-0 `__call_fn_method_0` dispatch, yielding a null iterator.
The wrapper-strip was reverted (the cast form is NOT in the 71 test262 fails —
it's a hand-written shape) and the null-guard (`if (iter !== null)`) was kept so
the cast form falls back cleanly to the fast path instead of trapping.

## Fix direction (deferred)

Two coupled pieces, both needed:
1. **Write-arm**: see through `ParenthesizedExpression`/`AsExpression` wrappers
   when matching the assignment target against `Array.prototype[...]`.
2. **Read-drive dispatch**: the cast-form generator closure must register a
   funcref type that `__call_fn_method_0` can resolve — investigate why the
   cast-form closure misses arity-0 dispatch (the bare-form closure resolves
   fine). Without (2), (1) alone re-introduces the null-iterator trap.

This is dispatch-plumbing, not in the conformance-critical path; deferred until
the bare-form CPR is fully banked.

## Acceptance

- `(Array.prototype as any)[Symbol.iterator] = function*(){ yield 42 };
  var [a,b,z] = [1,2,3];` → `z === 42`.
- No regression: bare-form CPR (the #1719 four contexts) stays green;
  override-free modules stay byte-identical.

## Source

Carved from #1719 CPR follow-ups (see #1719 issue file, CPR completion section).
