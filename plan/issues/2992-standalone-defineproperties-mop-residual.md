---
id: 2992
title: "Standalone defineProperties MOP residual (~250: array/arguments own-prop MOP + accessor-attribute fidelity + destructive verifyProperty/tombstone survival)"
status: in-progress
assignee: ttraenkler/fable-18th
sprint: Backlog
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2985, 2667]
loc-budget-allow:
  - src/codegen/declarations.ts
origin: "#2985 sizing-pass split — the substrate-scale MOP remainder after the illegal-cast slice shipped in #2985"
---

# #2992 — standalone defineProperties MOP residual (~250)

## Problem

Split out of #2985. #2985 was the whole `defineProperties` 5-b/6-a slab residual
(~250, mixed bucket). The bounded, discrete sub-bug (the `__obj_find`
illegal-cast on non-string computed keys) shipped in #2985. This issue carries
the **remaining ~250 substrate-scale MOP work**, which is genuinely
large/hard and wants further slicing:

- **array / arguments own-property MOP** — `defineProperty`/`defineProperties`
  on array indices and `length` with full attribute semantics.
- **accessor-attribute fidelity** — get/set descriptor round-trips through
  define → gOPD must preserve accessor identity and attribute flags.
- **destructive `verifyProperty` survival** — test262's `verifyProperty`
  mutates then restores the property; the standalone MOP must survive the
  define→delete→redefine cycle.

## Concrete evidence (measured 2026-07-02, standalone)

The destructive-`verifyProperty` sub-class has a reproducible root cause that is
**not key-type-specific** — a plain string-keyed delete→re-read already fails:

```ts
const o: any = {};
o["k"] = 1;
delete o["k"];
o["k"] === undefined; // FALSE in standalone (returns the stale value)
```

i.e. after `__delete_property` tombstones an entry, a subsequent read on the
same key does not consistently observe the tombstone. This is the mechanism
behind verifyProperty's define→delete→redefine failures and should be the first
slice (it is bounded and high-leverage). Suspect area: the tombstone-skip /
open-addressing read path in `__obj_find` / `__extern_get`
(`src/codegen/object-runtime.ts`).

## Acceptance

- Measured flip count on the `built-ins/Object/defineProperties` (and
  `defineProperty`) standalone subset, per sub-class, with zero regressions on a
  passing-test sweep.
- gc/host lane byte-inert (standalone-gated).

## Notes

Wants slicing into separate PRs:

1. delete-tombstone-read survival (bounded — start here). **SHIPPED — see slice-1 findings below.**
2. array/arguments index + `length` own-prop MOP.
3. accessor-attribute (get/set) define→gOPD fidelity.
4. (NEW, found during slice 1) nominal-struct field delete fidelity — see below.

## Slice 1 findings (measured 2026-07-10 on main 569e29b761, fable-18th)

The headline repro was re-measured and confirmed still failing — but the root
cause is NOT the tombstone machinery (`__obj_find`/`__extern_get` in
`object-runtime.ts` handle tombstones correctly; delete→read inside a function
works in every lane):

- **Actual root cause:** the module-level statement collector in
  `src/codegen/declarations.ts` recognises New/Call, ++/-- and assignment
  BinaryExpressions, but `delete o.k` is a `ts.DeleteExpression` — its own
  node kind, NOT a `PrefixUnaryExpression` — so a **top-level `delete`
  statement was silently dropped from `__module_init`** (the issue's repro is
  top-level). Reads then observed the stale value and `"k" in o` stayed true.
  Affected ALL lanes (gc / standalone / wasi) identically, not just standalone.
- **Fix (slice-1 PR):** collect `DeleteExpression` statements into
  `__module_init`; also unwrap `void <expr>` in top-level statement position
  (it was dropped the same way). Tests: `tests/issue-2992.test.ts` (12 cases,
  gc + standalone: read-after-delete, `in`, define→delete→redefine→delete
  cycle, parenthesized/void-wrapped, in-function control).
- **NEW sub-bug (slice 4, standalone only, pre-existing):** when shape
  inference promotes an all-prop-access object to a nominal struct
  (`o.k = 1; delete o.k; o.k === undefined` with every site using `.k`), the
  field is f64-typed: `delete` writes an `f64.const NaN` sentinel via the
  post-`__delete_property` arm and `o.k === undefined` is constant-folded to
  `i32.const 0` — the read can never observe undefined. Mixed elem/prop access
  keeps the object dynamic and passes. Not a regression from slice 1 (failed
  identically before, via the top-level drop).

## Test Results (slice 1)

- `tests/issue-2992.test.ts`: 12/12 pass (gc + standalone).
- Delete-family sweep (`tests/equivalence/delete-operator`, `delete-sentinel`,
  `issue-1821`, `issue-2130`, `issue-2726*`, `issue-1364b`): 43/44 pass — the
  one failure (`delete-sentinel > delete string property makes it undefined`)
  fails identically on unmodified main (pre-existing, in-function nominal-struct
  case — same mechanism as the slice-4 sub-bug above).
- Object/property sweep (`object-define-property*`, `object-keys`,
  `object-mutability`, `hasownproperty-call`, `empty-object-widening`,
  `numeric-key-object`): 52/52 pass.
