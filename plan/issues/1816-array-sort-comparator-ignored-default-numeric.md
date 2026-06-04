---
id: 1816
title: "Array.prototype.sort ignores user comparator; default sort numeric not lexicographic (residual #1361)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
parent: 1361
---
# #1816 — `Array.prototype.sort` ignores comparator + wrong default order

Residual of #1361 (marked done, sprint 51): the comparator is still ignored.

## Symptom
- `[3,1,2].sort((a,b)=>b-a)` → `[1,2,3]` (comparator dropped).
- `[10,9,1].sort()` → `[1,9,10]` instead of `[1,10,9]` (default must ToString-compare).

## Location
`src/codegen/array-methods.ts:5781-5816` validates a statically-non-callable
comparator (throws) but otherwise calls `ensureTimsortHelper`
(`src/codegen/timsort.ts`), which takes no comparator and hard-codes
`i32.lt_s`/`f64.lt`. The only test asserts "doesn't throw," masking it.

## Spec
ECMAScript §23.1.3.30 / SortIndexedProperties / CompareArrayElements.

## Fix
Thread the comparator funcref/closure into the sort and invoke via `call_ref`;
in the no-arg case compare by ToString (UTF-16 code units). Add a test that
asserts the resulting order, not just no-throw.

