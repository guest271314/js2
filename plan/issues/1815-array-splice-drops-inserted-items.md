---
id: 1815
title: "Array.prototype.splice drops inserted items (3+ args ignored)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution
`compileArraySplice` (`src/codegen/array-methods.ts`) now branches on
`insertCount = max(0, arguments.length - 2)`. When items are inserted it
rebuilds the backing array (`newLen = len - delCount + insertCount`), copies
head + items + tail into it, and writes the new data array + length back into
the **same** vec struct (in-place mutation preserved). This handles growth
(`insertCount > delCount`), shrink, and equal-size replacement. The deleted-
elements return value is unchanged. The delete-only path (no items) keeps the
original in-place tail-shift, which cannot exceed capacity.

## Test Results
`tests/issue-1815.test.ts` — 5/5 pass:
- `[1,2,3].splice(1,1,7,8)` → `[1,7,8,3]`, removed `[2]`
- `[1,2,3,4,5].splice(2,2,9)` → `[1,2,9,5]`, removed `[3,4]` (shrink)
- `[1,2,3].splice(1,0,8,9)` → `[1,8,9,2,3]`, removed `[]` (pure insert/grow)
- `[1,2,3].splice(3,0,4,5)` → `[1,2,3,4,5]`, removed `[]` (append)
- `[1,2,3,4].splice(1,2)` → `[1,4]`, removed `[2,3]` (delete-only, unchanged path)

