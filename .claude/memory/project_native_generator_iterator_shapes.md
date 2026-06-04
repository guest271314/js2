---
name: project-native-generator-iterator-shapes
description: Standalone native generators use a state-machine (not eager buffer); for-of drives resume() directly; iterator result struct shapes differ per backend and need
metadata: 
  node_type: memory
  type: project
  originSessionId: bd85f78e-e46f-4c52-b752-d9a8f971f948
---

Standalone/WASI `function*` generators do NOT use the JS-host `__gen_*` /
`__create_generator` scheduler and do NOT use an eager buffer. They lower to a
**pure-WasmGC state-machine** in `src/codegen/generators-native.ts` (#680): a
`gen()` call returns a `ref $__GenState_<name>` struct (field 0 = `state:i32`,
then captured params); `.next()` calls a generated `__gen_resume_<name>` resume
function that switches on `state` and returns the IteratorResult. No
`wasm_stack_switching` is used (verified — it's a plain state switch).

The IteratorResult struct is `__NativeGeneratorResult_f64` `{ value:f64,
done:i32 }` (built by `ensureNativeGeneratorResultType`), so native generators
only support **numeric (f64) yields** (`isNativeGeneratorCandidate` gate).

#1665 (PR #1070, merged 2026-06-03) wired `for-of` to this: when a for-of
subject's type resolves to a native generator state struct,
`compileForOfIterator` (`src/codegen/statements/loops.ts`) calls
`tryCompileNativeGeneratorForOf` (in generators-native.ts) which drives the
resume fn directly — bypassing `__iterator*` entirely, gated on
`ctx.standalone || ctx.wasi`. Before this, standalone for-of over a generator
hit the `#681` codegen gate and failed to compile.

**Why this matters / open seam:** there is NO shared polymorphic native
`$Iterator` interface yet. The generator path is struct-typed and direct.
dev-1776's #1103 Map/Set uses its OWN `{value:anyref, done:i32}` iterator
shape. These shapes (f64-value vs anyref-value) will need reconciling for the
**#1665a shared $Iterator unification** (future track) — that's where for-of,
generators, Map/Set, and custom `[Symbol.iterator]` structs would converge on
one native iterator-record contract. Until then each producer carries its own
result shape; do not assume a single `__iterator_next` ABI in standalone.

Related: [[project_next_session]].
