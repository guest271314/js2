---
id: 1835
title: "C-ABI string/array marshaling reads wrong header offsets (param + return)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
task_type: bugfix
area: codegen-linear
goal: correctness
sprint: 59
---
# #1835 — C-ABI string/array marshaling uses wrong header layout

## Symptom
Any WASI/C export taking or returning `string`/`T[]` over the C ABI hands the host
a wrong length and a pointer into the middle of the header → OOB reads / corrupted
strings. The C ABI is effectively non-functional for string/array I/O.

## Location
`src/codegen-linear/c-abi.ts:269-273` computes return data ptr = `ptr+4` and loads
length at `offset 0`. The verified linear layout (`src/codegen-linear/runtime.ts:505`)
is `[header 8B][len:u32 @ +8][bytes @ +12]` → length is at `offset 8`, data at
`ptr+12`. Param marshaling (`:231-246`) has the mirror problem — forwards a raw
`(ptr,len)` where the internal function expects a header object. **Verified.**

## Fix
Return: load length at `offset 8`, data pointer offset `12`. Param: construct a
runtime string/array object (e.g. `__str_from_data`) from `(ptr,len)` before calling
the internal function. Also remove the dead scaffolding at `:262-263` (see #1848).

