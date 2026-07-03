---
id: 2904
title: Standalone fixed-arity array destructuring leaks env::__array_from_iter_n
status: done
assignee: ttraenkler/sendev-iterdrain
sprint: 69
priority: high
horizon: l
feasibility: hard
goal: standalone-host-free
created: 2026-06-30
completed: 2026-06-30
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

## merge_group regression + fix (post-#2835 interaction)

The first cut regressed **440 standalone `*/dstr/*` tests (net -404)**, caught only
in the merge_group standalone-floor re-validation (PR checks were green). Root
cause — NOT a type-index shift (the i8-pack hypothesis): the unconditional native
`__array_from_iter_n` drain routed EVERY externref destructure source through the
native `__iterator`, whose **vec-only carrier hard-casts a non-`__vec_externref`
subject → `illegal cast`**. Indexable sources (function / class-method / for-of
array-pattern destructuring — `ary-ptrn-*`, `iter-close`, `iter-step-err`) that
passed on baseline via the `buildVecFromExternref` indexed-read fallback now
trapped.

Why baseline passed: `destructureParamArray`'s externref fallback has TWO
sub-paths — block A (`__array_from_iter_n` materialise + `__extern_length` /
`__extern_get_idx` read) and block B (`buildVecFromExternref`, indexed read). On
baseline the host `__array_from_iter_n` either didn't run for these or block B
handled them; my native helper made block A's `__iterator` drain ALWAYS run →
trap.

Fix (commit `b0e8e3bb9`): gate the iterator drain on `ref.test __vec_externref`.
A non-`$Vec` source is returned UNCHANGED so block A's own indexed read
(`__extern_length`/`__extern_get_idx`) handles it — byte-equivalent to the legacy
host result for an indexable source, host-free, and never trapping. Verified
30/30 previously-regressed dstr tests now pass; de-leak preserved; non-vec
iterables (generator/Set-as-any) degrade gracefully (they failed on baseline too).

## Test Results

`tests/issue-2904-standalone-fixed-dstr-iter-drain.test.ts` (7 cases, all green):
decl 2-of-3 / 3-of-3 positional, out-of-length default, elision, array-pattern
param, >4-element grow, undefined-check. Each asserts **zero host imports** + the
correct value. Regression sweep clean: #1592, #2169 (generator/spread/arrayfrom),
#1021/#1024/#1158 all green. The two pre-existing `#1320` `arr.entries()` failures
(`for (const pair of storedEntries)` → `pair.length`) reproduce **identically on
clean `origin/main`** — they are the #1888/#2177 open-any retrieval gap, NOT a
regression here (my new function is only reachable from the destructure site).

Host/gc mode still emits `env::__array_from_iter_n` → byte-identical, zero risk to
the JS-host lane.

## Scope landed vs. deferred

**Landed (this PR):** the dominant cluster — `const/let [a,b] = anyExpr` and
`function f([a,b]: any)` — both route through `destructureParamArray`'s externref
fallback and now drain host-free. Measured: the leak is gone and individual
destructured values bind correctly (`return a` → 10, defaults fire, elision works).

**Deferred (separate follow-ups, NOT regressions — all fail on base too):**

1. **`any + any` arithmetic on values read out of an `any` source.** `const [a,b] =
   anyArr; return a + b` yields 0/NaN — but so does `anyArr[0] + anyArr[1]` with NO
   destructuring at all. This is the pre-existing boxed-number value-read substrate
   gap (`project_standalone_any_string_value_read_substrate`), orthogonal to the
   host-import leak this issue targets. Individual reads and `any * number` work.
2. **Generator-as-`any` / Set-as-`any` destructure** (`const y:any = g(); const
   [a,b] = y`) traps `illegal cast` in the native `__iterator` USER arm — the
   #2157/#2864 standalone-iterator-of-`any` substrate. On base these failed at
   instantiation (the leak); now they trap at runtime (strictly no worse, and other
   functions in the same module become usable).
3. **Assignment-target destructure** (`[a,b] = anyExpr`, the
   `compileExternrefArrayDestructuringAssignment` site) still leaks. Swapping its
   materialise to the native helper removes the leak but its element reads use
   `__extern_get(box(i))`, which casts the boxed-number key to `$AnyString` and
   traps `illegal cast` in standalone. Converting those reads to `__extern_get_idx`
   surfaced a deeper USER-arm-fill dependency in that path; deferred to keep this PR
   zero-regression. The decl/param cluster is the overwhelming majority of the ~889.
