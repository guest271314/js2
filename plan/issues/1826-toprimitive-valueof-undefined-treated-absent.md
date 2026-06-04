---
id: 1826
title: "OrdinaryToPrimitive treats valueOf/toString returning undefined as method-absent"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: low
task_type: bugfix
area: runtime
goal: correctness
sprint: 59
---
# #1826 — `valueOf` returning `undefined` is treated as "absent"

## Symptom
`({valueOf(){return undefined}, toString(){return "x"}}) + ""` → `"x"` instead of
`"undefined"` — a method legitimately returning the primitive `undefined` is
skipped and the next method is consulted.

## Location
`src/runtime.ts:1943-2036`: `tryMethod` returns JS `undefined` both for
"absent / returned an object" and a real `undefined` primitive; the caller
(`:2026-2036`) treats `undefined` as "try the next method."

## Spec
ECMAScript §7.1.1.1 OrdinaryToPrimitive steps 5-6 (any non-Object return is the result).

## Fix
Use a distinct sentinel (unique symbol) for "absent / returned object" so a real
`undefined` primitive return is honored.

