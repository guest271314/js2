---
id: 1728
title: "ES5: compound assignment to unresolvable reference must throw ReferenceError"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: compound-assignment, reference-error
goal: test262-conformance
es_edition: 5
test262_category: language/expressions/compound-assignment
related: [1607]
---
# #1728 — ES5: compound assignment to unresolvable reference

## Problem

`language/expressions/compound-assignment/S11.13.2_A2.1_T3.*` (es5id
11.13.2_A2.1_T3.*) require that a compound assignment whose LHS is an
unresolvable reference throws **ReferenceError**:

```js
try { var z = (x += 1); throw new Test262Error(); }  // x undeclared
catch (e) { assert(e instanceof ReferenceError); }
```

We silently no-op'd (`x += 1` returned 0, no throw), so the test's `catch`
never fired and the assertion failed. Surfaced bucketing the ES5 (es5id)
edition failures (compound-assignment was the largest LOCALIZED bucket, ~98
es5id failures; the bigger Object.defineProperty/create buckets are the
architect-gated descriptor model).

## Root cause

Per §13.15.2 CompoundAssignmentEvaluation step 1.c, `lval = GetValue(lref)`
runs *before* the RHS; GetValue on an unresolvable reference throws
ReferenceError (§6.2.4) in both strict and sloppy mode. The compound-identifier
codegen (`src/codegen/expressions/assignment.ts`, the `localIdx === undefined`
branch) instead **auto-allocated a zero local** for the unknown name — a
graceful fallback that masked the unresolvable-reference error. The plain
*read* path already throws correctly (`identifiers.ts`), and the simple-assign
path already has the §6.2.4 PutValue guard; only compound assignment was
missing the GetValue-unresolvable throw.

## Fix

In the compound-identifier `localIdx === undefined` branch: if the LHS
identifier has **no resolved symbol** (`checker.getSymbolAtLocation` is
undefined) AND is not a module-global / captured-global, it is genuinely
undeclared — emit `emitThrowReferenceError("<name> is not defined")` instead of
auto-allocating. Names with a symbol (hoisted `var`, outer-scope bindings,
builtins) keep the graceful auto-allocate path. ~10 LOC, one branch.

Spec: ECMA-262 §13.15.2 CompoundAssignmentEvaluation, §6.2.4 GetValue/PutValue.

## Acceptance criteria

- `x += 1` (and `-= *= /= %=` etc.) with undeclared `x` throws ReferenceError. ✅
- Declared local / param / module-global / string compound assignment unchanged. ✅
- No regression in the compound-assignment equivalence suites. ✅

## Test Results

- `tests/issue-1728.test.ts` — 9/9 pass.
- `tests/equivalence/compound-assignment-{coercion,property,nonref-element}.test.ts`
  — 18/18 (no regression).

## Source

dev-b ES5 edition-bucket triage 2026-05-29 (Sprint 57 ES3/ES5 track).
