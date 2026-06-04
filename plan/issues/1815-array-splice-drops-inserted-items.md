---
id: 1815
title: "Array.prototype.splice drops inserted items (3+ args ignored)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1815 — `Array.prototype.splice` drops inserted items

## Symptom
`[1,2,3].splice(1,1,'a','b')` returns/leaves `[1,3]` instead of `[1,'a','b',3]`.
Inserted elements vanish.

## Location
`src/codegen/array-methods.ts:4421` (`compileArraySplice`) reads only `start`
(arg 0) and `deleteCount` (arg 1); never reads `arguments[2..]`. Dispatch at
`:2574` calls it unconditionally with no bail for 3+ args.

## Spec
ECMAScript §23.1.3.30 — insertion is core to splice.

## Fix
When `arguments.length > 2`, grow the backing array by `(items - delCount)`,
shift the tail, and write the item values at `start`. `toSpliced` already
implements this correctly (`:2899`) — reuse that shape. Or bail to host for the
insertion case as an interim.

## Acceptance
`[1,2,3].splice(1,1,'a','b')` → array becomes `[1,'a','b',3]`, returns `[2]`.

