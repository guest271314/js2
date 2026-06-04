---
id: 1847
title: "for-of tentative rollback truncates fctx.locals but does not restore fctx.localMap"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution

Added `snapshotLocals(fctx)` / `restoreLocals(fctx, snap)` to
`src/codegen/context/locals.ts`:
- `snapshotLocals` captures `locals.length` + the set of `localMap` names
  present at snapshot time.
- `restoreLocals` truncates `fctx.locals` back to the snapshot length, deletes
  every `localMap` name added since (whose slot the truncation removes), and
  prunes any `tempFreeList` bucket entry pointing past the new locals length
  (so the temp-reuse path can't hand out a dead slot). It deliberately does
  **not** touch `fctx.body` — callers truncate that themselves (the rollback
  body length is site-specific and captured separately).

Converted the four `fctx.locals.length =` rollback sites in
`src/codegen/statements/loops.ts` to snapshot/restore:
- `arrayValuesReceiverForForOf` (`.values()` receiver type probe),
- `compileForOfArrayTentative` (both the confirmed-vec and not-a-vec rollbacks),
- `compileForOfIterator` (standalone/WASI iterator fallback rollback).

The body-only error-rollback sites (`compileForOfString` / `compileForOfArray`
error paths) only truncate `fctx.body` and allocate no locals before the error,
so they are not part of this defect and are unchanged.

### Test Results
- `tests/issue-1847.test.ts` (4, all pass): restore drops post-snapshot
  localMap entries; re-allocating the same name after restore reuses an
  in-range slot the map agrees with; tempFreeList entries past the truncated
  vector are pruned; end-to-end two-consecutive-for-of compile produces valid
  Wasm returning 180.
- For-of generator / iterator suites green (the 3 `for-of-*destructuring*`
  files that failed to load are a pre-existing missing-`./helpers.js` harness
  issue, unrelated).

