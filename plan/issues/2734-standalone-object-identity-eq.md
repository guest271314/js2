---
id: 2734
title: "Standalone Array indexOf/includes/lastIndexOf lose object identity (regression from #2719)"
status: done
sprint: 67
created: 2026-06-27
updated: 2026-06-27
completed: 2026-06-27
priority: high
feasibility: medium
task_type: fix
area: codegen
language_feature: standalone
goal: standalone-everything
parent: 2711
related: [2719]
---
# #2734 — standalone object-identity search regression (from #2719)

**Follow-up fix for #2719.** Caught in the `merge_group` standalone floor (not at
PR level), behind a baseline that predated #2719's merge.

## Root cause

#2719 replaced the `__host_eq` / `__same_value_zero` host imports in the
standalone `indexOf`/`lastIndexOf`/`includes` arms with the native
`__extern_strict_eq` / `__extern_same_value_zero` helpers
(`src/codegen/any-helpers.ts`). Those compose `__any_from_extern` +
`__any_strict_eq` — but **`__any_from_extern` has no Object tag**: it folds an
object externref into the tag-5 (string) fallback (`fallbackStringAny`), so
`__any_strict_eq` string-compares two objects and never matches them by
identity.

Result: standalone `[0, o].indexOf(o)` → -1 (want 1), `includes(o)` → false,
`lastIndexOf(o)` → -1. Strings/numbers/NaN were correct (#2719's tests only
covered those — that's the gap that let this through). This regressed the
`built-ins/Array/prototype/{indexOf,lastIndexOf}/15.4.4.1{4,5}-*` object-element
cluster (20 standalone tests, signature `fb9900322f32d212`), which wedged the
merge queue (every PR parked against the pre-#2719 baseline).

## Fix

A `ref.eq` reference-identity fast path at the top of
`ensureExternStrictEqHelper`: internalise both externrefs (`any.convert_extern`);
if both are non-null `eq` refs and `ref.eq` (the SAME reference) → `===` → return
1; otherwise fall through to the existing `__any_strict_eq` primitive comparison.
`__extern_same_value_zero` (includes) calls `__extern_strict_eq`, so it inherits
the fix. Never false-positives a primitive (distinct number/string boxes are
distinct refs → value comparison); `null`/non-eq values fail `ref.test (ref eq)`
and fall through.

## Acceptance criteria

- [x] Standalone `indexOf`/`lastIndexOf`/`includes` find object/array elements by
      identity; distinct objects still miss; strings/numbers/NaN unchanged.
- [x] The 20 regressed `15.4.4.1{4,5}-*` object-element tests pass in standalone.
- [x] Host/gc mode unaffected (native helpers are standalone-only).

## Validation

- All 20 regressed test262 tests pass in standalone after the fix.
- `tests/issue-2734.test.ts` (13 cases: object/array identity, distinct-miss,
  string/number/NaN no-regression, host parity).
- `tests/issue-2719.test.ts` (string/number/NaN) still 14/14. `tsc` + prettier
  clean.

Once this lands, its merge_group shows +improvements (passes the floor) → the
baseline refreshes → the collateral parks on #2157/#2158/#2160 clear with no
change to them.
