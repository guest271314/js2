---
name: project-2186-vec-base-supertype
description: "#2186 added $__vec_base supertype so boxed arrays expose .length via __extern_length; indexing through externref still TODO"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2186 (PR #1667, sdev, 2026-06-18) fixed standalone array `.length` reading 0
through the externref boundary.

**Root cause:** array literals lower to per-element-kind `__vec_<elemKind>`
structs `(length i32, data (ref array))` via `getOrRegisterVecType`. There was
no common supertype, so `__extern_length` (which only knew `$ObjVec` /
array-like `$Object`) couldn't `ref.test` a boxed array → returned 0 for
`const a:any=[1,2,3]; a.length`.

**Fix / new foundation:** added `getOrRegisterVecBaseType(ctx)` →
`$__vec_base` struct, single field `length` (i32), `superTypeIdx: -1` (open).
Every `__vec_<elemKind>` now sets `superTypeIdx: vecBaseTypeIdx`. `length` at
field 0 is a valid struct-subtype prefix. `ctx.vecBaseTypeIdx` caches it.
`__extern_length` has a leading `$__vec_base` arm (`ref.test`→`ref.cast`→
`struct.get 0`→`f64.convert_i32_s`). Standalone-only (`objArrayLikeArms =
ctx.standalone`). Files: `registry/types.ts`, `context/{types,create-context}.ts`,
`object-runtime.ts`.

**Still TODO (scoped out, lower-impact):**
- **Element indexing through the boundary** `(arr as any)[i]`: element type is
  polymorphic (f64/externref/i32 differ), so `__extern_get_idx` can't read the
  element from `$__vec_base` alone — needs per-kind dispatch or a uniform
  boxed-element read. Build on `$__vec_base` (now `ref.test`-able) but add the
  element read. This + length together unblock ownKeys/apply argsList marshaling
  ([[project_1355_proxy_remaining_traps_blockers]] tasks #34/#36).
- The typed `string[]` direct-index returning `undefined` (`["x","y"][0]`) is a
  SEPARATE pre-existing string-array bug, unrelated.

**CI gotcha at the time:** the `quality` coercion-drift gate was pre-broken on
main (`json-codec-native.ts: 3→6`, stale baseline from #2166 JSON work) — failed
on base without this change. Not a #2186 regression. Whoever owns the JSON codec
must `node scripts/check-coercion-sites.mjs --update`.
