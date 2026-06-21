---
name: reference_2379_new_array_n_arraymethod_invalid_cast
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2379 (standalone Array.sort + family): a TOP-LEVEL `new Array(N).sort()` (and
filter/map/reduce/etc.) emits **invalid Wasm** — `Invalid types for ref.cast:
ref.as_non_null of (ref extern) has to be in the same reference type hierarchy as
(ref N)` in `__module_init`. Root cause: the array-method dispatch
(`compileArraySort` + all functional methods, `src/codegen/array-methods.ts`)
receives `vecTypeIdx`/`arrTypeIdx` and casts the receiver to the typed vec, but a
top-level `new Array(N)` is typed **`extern`**, not the inferred vec → static
`ref.cast extern→vec` is invalid. Broader than sort — the whole
`new Array(N).<method>` family. Fix direction (contained): at the array-method
cast site, if the receiver is `extern` (not the typed vec), BAIL to a
runtime/generic path instead of the invalid static cast.

CRITICAL HARNESS LESSON (cost me a near-miss): a synthetic probe wrapped in
`export function test(){ const a:any=new Array(2); a.sort(); ... }` **INSTANTIATES
fine** — the function-body codegen dodges the bug. The real test262 files run the
code at **module top-level** (`__module_init`), where the invalid cast is emitted.
So `new Array(2).sort()` in a function ≠ at top level. ALWAYS reproduce the bug in
the same scope the test262 file uses (top-level/module-init), not a convenience
function wrapper — wrapper-scope can mask module-init-only invalid-Wasm.

SUBSTRATE-MOVED reminder ([[reference_2372_dynamic_descriptor_struct_widening]]
#2162b pattern): I first measured this bug on a stale base; on current main the
function-wrapper form was already fixed but the top-level form still fails — always
re-ground the repro against CURRENT main AND in the file's real scope.
