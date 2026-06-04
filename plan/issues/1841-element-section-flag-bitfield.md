---
id: 1841
title: "Element-section flag bitfield: parser/emitter only handle active flag-0 (passive/declarative corrupt)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: low
feasibility: medium
task_type: bugfix
area: link
goal: correctness
sprint: 59
---
# #1841 — element-section flags mis-handled (latent)

Latent: only active flag-0 segments are fed to the linker today.

## Defects
- `src/link/reader.ts:471-501` (`parseElementSection`): `flags & 0x02` consumes a
  bogus tableidx for declarative (0x03); always scans for an offset-expr (passive/
  declarative have none) → desyncs the cursor.
- `src/link/linker.ts:401` re-emits every segment as active flag 0x00, discarding
  the original mode (declarative `ref.func` declarations become active table inits).

## Spec
WebAssembly binary — Element Section flag cases 0-7.

## Fix
Switch on the exact flag value per the spec table; carry the flag through
`ElementEntry` and re-emit the original mode.

## Resolution
- `parseElementSection` (`src/link/reader.ts`) now decodes the full 3-bit flags
  field per the spec's 8-case table: explicit tableidx only for flags 2 & 6;
  active offset-expr only for flags 0/2/4/6 (`null` for passive/declarative);
  elemkind/reftype byte for every flag except 0 & 4; payload `funcidx*` (0-3)
  vs `expr*` (4-7). Expr payloads are captured as raw bytes (each `expr`
  scanned to its `0x0b`) so they re-emit verbatim. This removes the cursor
  desync that previously corrupted every following section for any non-0 flag.
- `ElementEntry` carries `flags`, `offsetExpr: Uint8Array | null`,
  `elemCount`, `kindByte: number | null`, and `elemExprs: Uint8Array | null`.
- `linker.ts` re-emits each segment with its **original** flags/mode (offset/
  tableidx/kindbyte/payload conditioned on the flag bits) instead of forcing
  active flag-0 — declarative `ref.func` declarations no longer become active
  table inits.

### Test Results
- `tests/issue-1841.test.ts` (9, all pass): a roundtrip parse for each flag
  case 0-7 asserts the cursor lands exactly at the end (no desync) and the
  recovered fields (flags / tableidx / offset presence / kindByte / payload)
  are correct, plus a mixed three-segment body (active + declarative + passive-
  expr) parses without drift. A narrow `parseElementSegmentsForTest` export
  drives the parser without needing a full object file.
- `tests/object-file.test.ts` (12) green. (`linker-e2e.test.ts` is pre-broken
  on main via an unrelated self-compile `WasmEncoder_i64` error.)

