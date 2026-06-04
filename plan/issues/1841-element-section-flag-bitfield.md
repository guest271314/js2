---
id: 1841
title: "Element-section flag bitfield: parser/emitter only handle active flag-0 (passive/declarative corrupt)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

