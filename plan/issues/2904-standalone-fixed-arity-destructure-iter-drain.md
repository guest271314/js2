---
id: 2904
title: Standalone fixed-arity array destructuring leaks env::__array_from_iter_n
status: in-progress
assignee: ttraenkler/sendev-iterdrain
sprint: current
priority: high
horizon: l
feasibility: hard
goal: standalone-host-free
created: 2026-06-30
---

## Problem

On `--target standalone`, fixed-arity array destructuring of an `any`-typed
(externref) source leaks the host import `env::__array_from_iter_n`. A
leak-analysis of the full merge_group standalone report found ~889 tests leak
ONLY this import. #681 (iterator protocol) handled the general native-iterator
helpers and #2169 handled the native-generator / custom-iterable destructure
sources, but the fixed-N drain in `destructureParamArray`'s externref fallback
still emits the host import.

A leaked `env::` import makes the standalone module fail zero-import
instantiation, so every test in this cluster currently fails in standalone.

### Measured trigger (current main)

```
const [a,b] = (x as any)   →  LEAKS env::__array_from_iter_n
function f([a,b]: any) {}   →  LEAKS
[a,b] = (x as any)          →  LEAKS (assignment path, separate site)
const [a,b] = arr           →  clean (typed vec)
const [a,b] = gen()         →  clean (#2169 native-generator path)
const [a,b] = new Set(...)  →  clean
[...x]  (x: any)            →  clean (buildVecFromExternref indexed read)
```

The `any`-source path routes through `destructureParamArray`'s externref
fallback (`src/codegen/destructuring-params.ts` ~line 1340 + 1456), which
materialises via `__array_from_iter_n(param, stepCount)` then reads the result
with `__extern_length` + `__extern_get_idx` (both already native in standalone).
`compileExternrefArrayDestructuringDecl` (decl `const [a,b]=x`) and array-pattern
params both delegate here, so a single fix covers both.

## Root cause

`__array_from_iter_n` is defined ONLY in `src/runtime.ts` (the JS host). There
is no native/standalone Wasm definition, so `ensureLateImport` registers it as a
plain `env::` host import under standalone. The general native iterator runtime
(`__iterator` / `__iterator_next`, #681/#2038) already exists in standalone and
already handles both the VEC arm (native indexable vecs) and the USER arm
(generators / custom `@@iterator`, filled at finalize by
`fillNativeIteratorUserArms`). The fixed-N drain simply never reused it.

## Fix

Add a native standalone `__array_from_iter_n(externref, f64) -> externref`
defined function (`ensureNativeArrayFromIterN` in `iterator-native.ts`) that
drains via the existing `__iterator` / `__iterator_next` into a growable
`__vec_externref`, returning it as externref. Downstream `__extern_length` /
`__extern_get_idx` already read `__vec_externref` (it is a `vecTypeMap` carrier),
so the consuming code is unchanged.

The drain loop mirrors the proven spread-override drain
(`src/codegen/literals.ts` ~line 3806): array-doubling growth + `array.copy`,
`(done,value)=__iterator_next(iter)`, bounded by the f64 step count for no-rest
patterns (exactly N `.next()` calls per §8.5.2) or unbounded for rest (-1). A
`ref.is_null` guard returns an empty vec for null/undefined sources, matching the
host `_arrayFromIter(null) → []`.

Gate the `ensureLateImport(ctx, "__array_from_iter_n", …)` call site(s): under
`ctx.standalone || ctx.wasi` call `ensureNativeArrayFromIterN(ctx)` (appends a
defined func — no funcIdx shift), else keep the host import. The existing
`ctx.funcMap.get("__array_from_iter_n")` re-resolution is unchanged and
byte-identical in host mode.

## Why this is safe (downstream effects)

- Registering a DEFINED function is append-only — it does NOT shift existing
  function indices the way adding an `env` import does. The helper body's
  `call __iterator` / `call __iterator_next` funcIdx are captured post-runtime
  registration and patched by `shiftLateImportIndices` like every other defined
  body if a later import shifts them.
- Host mode (`!standalone && !wasi`) keeps the `env::__array_from_iter_n` import
  → byte-identical, zero risk to the JS-host lane.
- `fillNativeIteratorUserArms` runs unconditionally at finalize (index.ts:1752)
  gated on `nativeIteratorUserArmPending`, which `ensureNativeIteratorRuntime`
  (called transitively) sets — so generator / custom-iterable `any` sources get
  the USER arm.

## Acceptance

- The `any`-source fixed-arity destructure cluster compiles host-free (no
  `env::__array_from_iter_n`).
- Corpus-verify via wrapTest on real destructuring test262 cases.
- gc-mode output unchanged.
- Full merge_group NET-POSITIVE, zero regression.

## Test Results

(filled during implementation)
