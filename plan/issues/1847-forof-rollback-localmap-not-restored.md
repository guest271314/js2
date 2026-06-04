---
id: 1847
title: "for-of tentative rollback truncates fctx.locals but does not restore fctx.localMap"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: low
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1847 — for-of rollback leaves stale localMap entries

## Defect
`src/codegen/statements/loops.ts:2590-2599` (and siblings `:2615/2624/2632`,
`compileForOfString` `:2432`, `compileForOfIterator` `:3485`) roll back
`fctx.body.length` and `fctx.locals.length` but not `fctx.localMap` (which
`allocLocal` mutates). Stale entries then point past the truncated locals vector.
Practical risk is low (temp names are keyed off `locals.length`), but the state is
unbalanced.

## Fix
Snapshot/restore `fctx.localMap` (and `tempFreeList`) alongside `locals.length`, or
delete names allocated since the snapshot.

