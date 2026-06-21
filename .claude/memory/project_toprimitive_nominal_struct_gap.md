---
name: project_toprimitive_nominal_struct_gap
description: Standalone ToPrimitive
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#50 / #1917 standalone ToPrimitive residual root cause (confirmed 2026-06-18 vs upstream/main ea97d05):

Native `__to_primitive` (`src/codegen/object-runtime.ts:1910`) only recognizes the **dynamic `$Object` runtime struct** via `ref.test objectTypeIdx`. A **typed object literal** compiles to a *nominal* WasmGC struct. When that nominal struct reaches `__to_primitive` through the externref boundary (`any.convert_extern` → `ref.test objectTypeIdx` MISSES), the object passes through unchanged → `__unbox_number(object)` → NaN.

The WORKING `*`/`-`/unary-minus path uses **static valueOf dispatch** (`type-coercion.ts:1723`): it reads the struct's TS fields at compile time and inlines the `valueOf` call — needs the concrete typeIdx, which is lost once an operand is coerced to externref.

Manifestations on main (all share this one gap):
- `+` with object operands is BROKEN (re-scope wrongly said it was fixed): `{valueOf:()=>4}+{valueOf:()=>3}`, `obj+1`, `1+obj` all return the RAW OBJECT. `+` routes through `emitAnyAdd` (`binary-ops.ts:2845`) → externref/`__to_primitive`.
- `function f(x:any){return x*2}` with an object arg → NaN (the `type-coercion.ts:1360` externref→f64 arm).
- valueOf-returns-object cases trip latent codegen bugs: "type error in fallthru[0] (expected f64, got externref)" and "illegal cast".

The single engine fix (native `__to_primitive` that recognizes nominal object structs through externref — brand/RTTI bit on object structs, or unify to `$Object`) closes ALL of the above. This is architect-scale (#1917 epic), NOT a per-operator dev slice. Fold with [[project_bigint_i64_brand_gate]]-style brand decisions and #10 (Number(array)). The 2026-06-12 standalone JSONL bucket (107 "Cannot convert object to primitive") is stale — re-measure on a fresh shard.
