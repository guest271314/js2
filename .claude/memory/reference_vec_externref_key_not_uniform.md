---
name: reference-vec-externref-key-not-uniform
description: "ctx.vecTypeMap \"externref\"-keyed carriers are not uniformly (array externref) — some have a ref/ref_null element override"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

In `src/codegen/registry/types.ts`, `getOrRegisterVecType(ctx, elemKind, elemTypeOverride)`
dedups vec carriers by the **string key** `elemKind`. The key `"externref"` does
NOT guarantee the backing array's element ValType is `externref`:

- `function-body.ts` (the `arguments` object) and `closures.ts` (closure-arg
  vecs) call `getOrRegisterVecType(ctx, "externref", elemType)` where `elemType`
  can be a `ref`/`ref_null` to a GC struct.
- `getOrRegisterArrayType` then rewrites a `ref` element to `ref_null`.

So `getArrTypeIdxFromVec(ctx, vecTypeIdxForExternrefKey)` → `arrDef.element` may
be `(ref null N)`, not `externref`. **Why it matters:** any codegen that
enumerates `ctx.vecTypeMap` and assumes the `"externref"` carrier yields an
`externref` from `array.get` (e.g. an identity "already externref" path) will
emit a `(ref null N)` where `externref` is required → invalid Wasm
(`return[0] expected externref, got (ref null N)`). This bit #2190's
`__extern_get_idx` typed-vec indexing arms: the safe rule is to only synthesize
arms for element kinds whose box op PROVABLY yields a fresh `externref` (plain
`f64`/`i32` via `__box_number`), and skip every ref-family carrier. Read the
**actual `arrDef.element` ValType**, never trust the vecTypeMap key. See
[[reference_error_analysis]].
