---
id: 1835
title: "C-ABI string/array marshaling reads wrong header offsets (param + return)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
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

## Resolution (2026-06-04)
Fixed in `src/codegen-linear/c-abi.ts`, `src/codegen-linear/runtime.ts`,
`src/compiler/output.ts`:

- **Return marshaling**: now loads length at `+8` (`AGG_LEN_OFFSET`) and exposes
  the data pointer at `headerPtr + STR_DATA_OFFSET (12)` for strings and
  `headerPtr + ARR_DATA_OFFSET (16)` for arrays. String vs array offset is
  selected from `info.result.semantic`. Offset constants are declared once in
  c-abi.ts and documented as mirroring runtime.ts.
- **Param marshaling**: a `string`/`array` C param arrives as a raw `(ptr, len)`
  pair; the wrapper now rehydrates an internal header object by calling
  `__str_from_data(ptr, len)` / `__arr_from_data(ptr, len)` before invoking the
  internal function. `CabiParam` carries an `aggregate` discriminator so the
  wrapper picks the right constructor.
- Added the `__arr_from_data(dataPtr, len) → headerPtr` runtime helper to
  `addArrayRuntime` (allocates `16 + len*4`, tags Array, sets len/cap, copies
  `len` i32 elements).
- Removed the dead `body.splice(body.length, 0)` no-op and unused `callIdx`
  (partial #1848 sweep).
- Wired `applyCabiTransform` to receive the typed AST so it can classify
  string/array params/returns (they lower to i32 header pointers, otherwise
  indistinguishable from numbers). TS-type inference only applies when the
  declared param count matches the Wasm param count, so a prepended
  `this`/closure slot falls back to scalar treatment.

## Test Results
`tests/issue-1835.test.ts` — 7/7 pass:
- string return → `(dataPtr, len)` decodes to the correct UTF-8 (`"Hi"`, len 2;
  `"hello world"`, len 11)
- string param rehydrated → `lenOf("hello") === 5`; empty string → `0`
- array return → `(dataPtr, len=3)`, elements `[10, 20, 30]` read directly
- scalar `add(3, 4) === 7` unaffected
- C header emits an out-param signature for the string return

Existing `tests/c-abi.test.ts` (38) and linear-array/advanced/wasi suites stay green.
