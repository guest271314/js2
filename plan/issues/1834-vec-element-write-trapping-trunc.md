---
id: 1834
title: "Vec element-write/length index uses trapping i32.trunc_f64_s instead of saturating"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: codegen
goal: compilable
sprint: 59
---
# #1834 — element-write index uses trapping truncation

## Symptom
A NaN / non-integer / out-of-range index in destructuring element-assignment (or
`arr.length = N`) traps the module instead of being clamped.

## Location
`src/codegen/expressions/assignment.ts` — the element-access index path and the
`arr.length = N` path used `i32.trunc_f64_s`. Every other index/length
conversion in the file uses `i32.trunc_sat_f64_s`.

## Fix
Both sites now emit `i32.trunc_sat_f64_s`, matching the rest of the file:
NaN/Infinity/out-of-range clamp instead of trapping.

## Test Results
`tests/issue-1825.test.ts` — vec write-index block (3 cases): `arr.length = NaN`
→ 0 (no trap), `arr.length = 1e30` → clamps to i32 max (no trap), normal
`arr.length = 2` → 2. All pass.
