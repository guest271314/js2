---
id: 1834
title: "Vec element-write/length index uses trapping i32.trunc_f64_s instead of saturating"
status: ready
created: 2026-06-04
updated: 2026-06-04
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
`src/codegen/expressions/assignment.ts:1805` (element-access index) and `:2305`
(`arr.length = N`) use `i32.trunc_f64_s`. Every other index/length conversion in
the file uses `i32.trunc_sat_f64_s` (`:3012,:3685,:4170,:5538`).

## Fix
Use `i32.trunc_sat_f64_s` to match the rest of the file.

