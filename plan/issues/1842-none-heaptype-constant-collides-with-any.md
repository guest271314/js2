---
id: 1842
title: "none heap-type constant collides with any (0x6e); noextern/nofunc missing"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution
Corrected `TYPE.none` in `src/emit/opcodes.ts` from `0x6e` (which aliased
`TYPE.any`) to `0x71`, and added `noextern: 0x72` / `nofunc: 0x73`. Verified
`0x71/0x72/0x73` were free within the `TYPE` table (the same bytes appear in the
unrelated OP / SIMD opcode tables, different namespaces). `TYPE.none` has no
current emitter use site (latent), so no behavior changes today — this removes
the landmine for future bottom-type emission.

### Test Results
- `tests/issue-1842.test.ts` (3, all pass): `none/noextern/nofunc` use the spec
  bottom-type bytes; `none` no longer collides with `any`; the abstract
  heap-type bytes match the spec table (`any=0x6e, eq=0x6d, i31=0x6c,
  struct=0x6b, array=0x6a`; `funcref=0x70` distinct from the `func` type-def
  tag `0x60`).
- `tests/object-file.test.ts` (12) green — no emit regression.

