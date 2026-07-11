---
id: 2992
title: "Standalone defineProperties MOP residual (~250: array/arguments own-prop MOP + accessor-attribute fidelity + destructive verifyProperty/tombstone survival)"
status: in-progress
assignee: ttraenkler/fable-sub2
sprint: Backlog
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2985, 2667]
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-ops.ts
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
2. array/arguments index + `length` own-prop MOP. **BLOCKED on the vec-receiver own-prop substrate (see slice-3 findings) — no bounded slice (#2986 agrees).**
3. accessor-attribute (get/set) define→gOPD fidelity. **SHIPPED (with the broader §10.1.6.3 partial-descriptor MERGE) — see slice-3 findings below.**
4. (NEW, found during slice 1) nominal-struct field delete fidelity — see below.
5. (NEW, found during slice 3) accessor/own-prop MOP on CLOSED-STRUCT receivers (`__extern_get` accessor arm misses; hasOwnProperty/delete invisible) — the biggest residual cluster (4-75/4-82-* family), substrate-adjacent to slice 2 and slice 4.

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

## Slice 3 findings (measured 2026-07-11 on main 026f40f771, fable-sub2)

Fresh-baseline re-measure (2026-07-11 standalone jsonl, post-slice-1): the
`defineProperty`/`defineProperties` standalone-fail/host-pass gap is **560**.
Root-caused via the real runner pipeline (`runTest262File(..., "standalone")`
— reduced probes MISLEAD here because the runner wraps the test body in
`export function test()`, which changes shape inference):

- **Partial-descriptor redefine CLOBBERED (fixed this slice):**
  `__defineProperty_value` / `__defineProperty_accessor` blanket-inserted on
  redefine — unspecified attributes reset to false, a flags-only define
  clobbered [[Value]] with null, and FLAG_ACCESSOR (+ live get/set halves) was
  wiped. Both appliers now MERGE in place per §10.1.6.3, driven by the
  specified-bits (3/4/5 existing; NEW bits 8/9 = get/set specified,
  standalone-gated at call sites, legacy no-bits ⇒ replace-both).
- **Accessor identity (fixed):** `get: someIdentifier` re-synthesized a fresh
  closure from the AST (`emitAccessorRefValue` standalone arm) — gOPD read
  back a different function (`desc.get === getFunc` false). Identifiers now
  compile to their live closure VALUE (driver-invocable; verified via the
  dynamic-descriptor path which always stored raw values).
- **Explicit `get: undefined` / `set: undefined` (fixed):** dropped at the
  call site; now routed as PRESENT accessor fields (specified bit + null
  half), so 15.2.3.6-4-439-style gOPD `hasOwnProperty("get")` passes and a
  later data-redefine on the non-configurable accessor throws.
- **Non-configurable accessor validation (fixed):** the accessor applier had
  NO §10.1.6.3 rejections — configurable/enumerable flips, data→accessor
  conversion, and get/set SameValue changes on a non-configurable property
  now throw catchable TypeErrors; new-key define on a non-extensible object
  throws (was a silent no-op).
- **Explicit `get: null` → TypeError is implemented but only observable under
  the `undefinedSingleton` regime (#2106, default OFF)** — legacy regime
  cannot distinguish stored null from undefined, so those ~6 tests stay red.
- **Out of slice (measured, blocked on the vec/closed-struct receiver
  substrate — same wall as #2986's sizing):** (a) exotic DESCRIPTOR receivers
  (array/arguments/function/Error descriptors, incl. inherited fields) — even
  plain expando reads fail on those receivers; (b) array-index/length
  attribute MOP (~109 "expected TypeError" tests, slice 2); (c) accessor
  define on CLOSED-STRUCT receivers (runner-wrapped `var obj = {}` with pure
  prop access) — `__extern_get` accessor-arm reads miss; affects the large
  4-75/4-82-* residual. All shapes fail identically on unmodified main
  (verified) — no regression from this slice.

Measured sample flips (runner pipeline, standalone): 11 of 144 sampled gap
tests flip to pass (4-439, 7-6-a-105, 7-6-a-38-1, 4-336, 4-373, 4-381, 4-430,
4-448, 4-454, 4-457, 4-508); merge semantics also serve every
verifyProperty-style partial redefine outside these buckets. Regression
sweeps: 142/142 baseline-passing tests (defineProperty/ies, freeze, seal,
preventExtensions, create, gOPD, Reflect, Array.prototype, Boolean) still
pass; equivalence `object-define-property*`, `define-property-typeerror`,
`hasownproperty-call`: 46/46; `tests/issue-2992.test.ts` 12/12;
new `tests/issue-2992-accessor-merge.test.ts` 18/18 (gc + standalone).

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
