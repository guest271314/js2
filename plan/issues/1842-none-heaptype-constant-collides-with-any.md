---
id: 1842
title: "none heap-type constant collides with any (0x6e); noextern/nofunc missing"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: low
feasibility: low
task_type: bugfix
area: emit
goal: correctness
sprint: 59
---
# #1842 — `none` heap-type constant is wrong (latent)

## Defect
`src/emit/opcodes.ts:444` defines `none: 0x6e`, the same byte as `any: 0x6e` (`:439`).
Spec: `none = 0x71`, `noextern = 0x72`, `nofunc = 0x73`. `noextern`/`nofunc` are
absent entirely. **Verified.** Latent — `TYPE.none` is not emitted today — but a
landmine for any future bottom-type emission.

## Spec
WebAssembly GC binary/types — abstract heap-type encodings.

## Fix
`none: 0x71`; add `noextern: 0x72`, `nofunc: 0x73`.

