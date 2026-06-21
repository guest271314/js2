---
name: reference-no-rebuild-helper-body-at-finalize
description: Never REBUILD a native-helper body at finalize that bakes funcIdxs — it breaks the late-import shift invariant; splice instead
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

The `addUnionImports` / late-import funcIdx-shift machinery (see CLAUDE.md
"addUnionImports") walks already-emitted function bodies and ADJUSTS every baked
`{op:"call", funcIdx}` when imports are added after the body was registered. That
invariant **only holds for a body baked ONCE at registration time.**

If a deferred FINALIZE-time fill (`fillX`) does `fn.body = rebuildWholeBody({...})`
and re-bakes `call` funcIdxs (e.g. `ctx.funcMap.get("number_toString")` /
`__extern_get`) with the *then-current* values, a subsequent reconcile shift will
**double-apply** to those re-baked targets → corrupted call → invalid Wasm
(observed as `type error in return[0]` / wrong-typed call, in modules that hit the
re-baked arm). This bit #2190's `fillExternGetIdxVecArms`: rebuilding the
`__extern_get_idx` body re-baked the `$Object` arm's `number_toString`/
`__extern_get` calls and regressed ~120 generator/async + destructuring-rest +
TypedArray modules (breaching the #2097 standalone high-water floor) — and it did
so REGARDLESS of which element kinds the new arms boxed (proving the arms were
never the cause).

Rule: a `fillX` that augments an existing helper must **SPLICE** new instrs into
the existing `fn.body` (`fn.body.splice(afterPreamble, 0, ...newArms)`), never
rebuild it. `fillExternIsArray` is safe because it builds a body with NO `call`
to a shiftable defined-func (only `ref.test`/`i32.const`). See
[[reference_vec_externref_key_not_uniform]].

## Related: `mod.functions[funcIdx - numImportFuncs]` is shift-sensitive (#2191)

The same funcIdx-shift class bit #2191 differently: a helper-repoint
(`case-convert-native.ts`, #40 toUpperCase ascii→uni) located the function to
patch via `ctx.mod.functions[asciiIdx - ctx.numImportFuncs]`, where `asciiIdx`
was captured EARLIER (in `nativeStrHelpers`). A late import added between that
capture and the patch grew `ctx.numImportFuncs`, so the index pointed at the
WRONG function — patching some other fn and leaving the real one un-patched
(`"à".toUpperCase()` via `===` called the un-patched ascii body → intransitive
`===` vs `charCodeAt`). Rule: to mutate/repoint a helper at a later phase,
resolve it by **name** (`ctx.mod.functions.find(f=>f.name===X)`) or re-point the
NAME in `funcMap`/`nativeStrHelpers` to the target funcIdx — never index
`mod.functions[capturedIdx - numImportFuncs]` across a phase where imports may
have been added.
