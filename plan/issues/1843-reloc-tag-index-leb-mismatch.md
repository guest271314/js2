---
id: 1843
title: "R_WASM_TAG_INDEX_LEB mismatch between emitter (11) and reader (10)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

