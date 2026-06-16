---
id: 1843
title: "R_WASM_TAG_INDEX_LEB mismatch between emitter (11) and reader (10)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: low
feasibility: low
task_type: bugfix
area: link
goal: correctness
sprint: 59
---
# #1843 — tag-index relocation type number disagrees (latent)

## Defect
`src/emit/opcodes.ts:480` defines `R_WASM_TAG_INDEX_LEB: 11`, but
`src/link/reader.ts:136` defines it as `10` (LLVM canonical is `10`). A tag
relocation written by the emitter (11) is parsed by the reader as unknown.
**Verified.** Latent (linker path not in production).

## Fix
Align both on `10` — correct `opcodes.ts:480`.

## Resolution
Changed `RELOC.R_WASM_TAG_INDEX_LEB` in `src/emit/opcodes.ts` from `11` to `10`
(LLVM canonical; historically `R_WASM_EVENT_INDEX_LEB`). The reader
(`src/link/reader.ts`) already used `10`, and slot `10` was unused on the
emitter side (table jumped 9 → 11), so there is no collision. The single
emitter use site (`src/emit/object.ts:889`, `throw` tag relocation) now writes
the value the reader parses.

### Test Results
- `tests/issue-1843.test.ts` (2, all pass): pins `R_WASM_TAG_INDEX_LEB === 10`
  on both sides, plus a cross-table guard that asserts **every** reloc type
  defined on both the emitter and the reader uses the same number — preventing
  future drift (the root cause here).
- `tests/object-file.test.ts` (12) green.
- `tests/linker-e2e.test.ts` fails 3 tests identically on clean main
  (`WasmEncoder_i64 ... local.tee` self-compilation error) — a pre-existing
  failure unrelated to this change (verified by stash-diff).

