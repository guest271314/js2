---
name: project_2151_any_receiver_dispatch_slices
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2151 (standalone any-receiver method dispatch on closed object-literal structs)
is an incremental **multi-slice** effort, not one PR. Closed object literals
compile to nominal WasmGC structs (methods = sibling `<Struct>_<method>` funcs),
NOT the open `$Object`, so the host `__extern_method_call` `ref.test $Object`
fallback never invokes them. The fix family is per-method-name **type-switch
dispatchers** `__call_m_<name>_<arity>` / `__call_m_<name>_vararg` in
`src/codegen/closed-method-dispatch.ts` (reserve-then-fill #1719), routed from
the any-receiver call site in `src/codegen/expressions/calls.ts`.

Slices landed: 1 (0-arg, PR-pre), 2 (N-ary fixed, #1497), 3 (static
array-literal spread, #1628), 4 (pure dynamic spread `o.m(...xs)` via vararg
dispatcher, #1766). **Slice 5 (mine, 2026-06-21): mixed spread `o.m(a, ...xs)`**
— build the combined arg `$ObjVec` at runtime (push fixed args, loop-append the
spread source via `__extern_length`/`__extern_get_idx`) and hand to the Slice 4
vararg dispatcher = **PR #1814**.

**How to apply:** all slices are gated `ctx.standalone` (the array-like
`__extern_get_idx` arms are standalone-only; wasi is a separate widening).
Host-mode any-method on closed object literals is a known pre-existing limitation
(out of scope). When extending: reserve the dispatcher, add late imports, then
**re-resolve every funcIdx by name after `flushLateImportShifts`** (#2043 class —
late imports shift the reserved dispatcher's index too). Residuals still open:
wasi, ref/string-typed params (`o.g("hi")`), multiple/leading spreads.
