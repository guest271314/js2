---
id: 2029
title: "standalone: `Binary emit error: u32 out of range: -1` on builtin subclassing, disposal protocol, Object.create, Iterator.prototype (497 tests)"
status: in-progress
sprint: 66
created: 2026-06-10
updated: 2026-06-24
priority: critical
assignee: ttraenkler/cs-2160
feasibility: medium
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen, emit
language_feature: classes, explicit-resource-management, objects
goal: standalone-mode
related: [1809, 1839, 1888, 1666]
test262_bucket: standalone-emit-u32-range
test262_count: 497
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff (test262-standalone-current.jsonl, run 10.6.2026 00:56): 497 host-pass tests emit `u32 out of range: -1`/`undefined` under --target standalone."
---

# #2029 — standalone: `Binary emit error: u32 out of range: -1` bucket

## Problem

497 tests that pass in JS-host mode die at **emit time** under
`--target standalone` with the raw encoder error
`Binary emit error: u32 out of range: -1` (a smaller sub-bucket says
`u32 out of range: undefined`). The compiler never produces a binary — these
are hard compile errors, not refusals, so the whole file (often L1:1) is lost.

Path clusters (from the 2026-06-10 standalone baseline JSONL, gap rows where
host passes):

| Count | Cluster |
| ---: | --- |
| 83 | `language/statements/class` (incl. all `subclass-builtins/*`) |
| 74 | `built-ins/Object/create` |
| 45 | `language/expressions/class` |
| 44 | `built-ins/Iterator/prototype` |
| 29 | `built-ins/Array/prototype` |
| 24 + 20 | `built-ins/DisposableStack` + `AsyncDisposableStack` |
| 23 | `language/statements/for-await-of` |
| rest | `await-using`, `for-of`, `assignment`, dynamic-import namespace… |

## Minimal repro (confirmed on main @ 936d1ac51, 2026-06-10)

```bash
npx tsx src/cli.ts repro.ts --target standalone -o out/
# repro.ts:
#   class MyArr extends Uint8Array {}
#   const a = new MyArr();
#   console.log(a instanceof MyArr);
```

→ `repro.ts:1:1 - error: Binary emit error: u32 out of range: -1`

The same file compiles and runs in default (gc/JS-host) mode.

Other failing shapes from the bucket:

- `class A extends BigUint64Array {}` (any builtin subclass)
- `await using x = { [Symbol.asyncDispose]() {} }` / DisposableStack methods
- `Object.create(proto, …)` forms in `built-ins/Object/create`
- `Iterator.prototype` helper tests

## Root cause in compiler

`RangeError` thrown by the LEB encoder at `src/emit/encoder.ts:21` — some
index field is `-1` (failed map lookup) or `undefined` when the module is
serialized.

**Important diagnostic finding:** the existing env-gated guard
`JS2WASM_VALIDATE_FUNCREFS=1` (`validateFuncRefs`, `src/emit/binary.ts:105`)
does **NOT** fire on the minimal repro — the error stays the raw encoder
message. So this is *not* (only) the known late-import `call`/`ref.func`
funcIdx-shift class (#1809/#1839): the `-1` lives in a u32 the walker does not
cover — candidates: a type index (`ref null <t>`/`call_ref`/`struct.new`
typeIdx), a global index, an export index, or a table/element field. The
standalone path (no JS-host imports → different import-section layout and
late-import flushing) is what exposes it.

## Suggested fix

1. Extend `validateFuncRefs` (or add a sibling `validateIndices`) to check
   every u32 index field the encoder writes (typeIdx, globalIdx, tableIdx,
   localIdx, exports) so the failure becomes a named, located codegen error —
   then the actual broken producer is identifiable in one compile.
2. Run the minimal repro, identify the producer (likely builtin-subclass
   class layout or the disposal/iterator-helper lowering registering a type
   or global only on the JS-host path), and fix the standalone branch.
3. Keep the dual-mode invariant from #1888: if a construct genuinely cannot
   lower standalone yet, it must refuse loudly via `reportError*`, never
   reach the encoder with a poisoned index.

## Acceptance criteria

- `class MyArr extends Uint8Array {}` compiles (or refuses loudly with a
  specific message) under `--target standalone`.
- `test/language/statements/class/subclass-builtins/*`,
  `built-ins/Object/create/*`, and the DisposableStack/await-using clusters
  no longer report `u32 out of range` in the standalone lane.
- Emit-time index validation produces a named error with location for any
  future `-1`/`undefined` index (no more opaque encoder RangeError).
- Bucket reduced from 497 toward 0; no host-mode regressions.

## Producer diagnosis (2026-06-10, from the #2043 always-on validation — sd-fable-emit)

The #2043 PR landed inline emit-time index validation; the minimal repro now
fails with the named error instead of the raw RangeError:

```
Codegen error: global index out of range — -1 (valid: [0, 3)) at function 'MyArr_new'. …
```

**Confirmed producer for the builtin-subclass cluster:** under
standalone/nativeStrings, `addStringConstantGlobal`
(`src/codegen/registry/imports.ts:74`) stores the documented **-1 sentinel**
in `ctx.stringGlobalMap` ("no host import — materialize inline at use
sites", #1174). `emitSetSubclassProto` (`src/codegen/class-bodies.ts:230-254`)
then reads `ctx.stringGlobalMap.get(subName/parentName)` and guards only
`undefined` — NOT the -1 sentinel — before emitting
`{ op: "global.get", index: subNameGlobal }` into the if/else arm. Note the
flow also implies `ensureLateImport("__set_subclass_proto", …)` returned a
defined index under `--target standalone` (the early standalone return did
not trigger) — check whether that import should exist standalone at all.

**Fix shape:** in `emitSetSubclassProto`, treat `-1` like the comment in
`addStringConstantGlobal` prescribes (use the native string materialization
path, or skip the proto adjustment + record a standalone fallback), and
audit every other `stringGlobalMap.get` consumer for the same missing
sentinel check — the Object.create / Iterator.prototype / DisposableStack
clusters in this bucket are likely the same pattern. `grep -n
"stringGlobalMap.get" src/codegen/` and check each use site emits
`global.get` only for `idx >= 0`.

## PR-1 landed (2026-06-15, sdev3) — builtin-subclass cluster

Applied the prescribed fix shape to the confirmed producer. `emitSetSubclassProto`
(`src/codegen/class-bodies.ts`) now skips the prototype-adjustment arm when
either class-name string global is the `-1` sentinel (standalone/`nativeStrings`),
in addition to the existing `=== undefined` guard. The arm exists only to feed
the `__set_subclass_proto` HOST import (unavailable standalone anyway), and the
WasmGC instance `__tag` already carries class identity for `instanceof`, so
skipping is semantically correct standalone.

**Fixed (compile-time emit crash gone):** `class X extends Error/TypeError/
Uint8Array {}` and `extends`-builtin with own field / explicit `super()` /
implicit ctor / 3-level hierarchy / class-expression — all the
`language/{statements,expressions}/class` + `subclass-builtins/*` clusters
(≈128 of the 497) now COMPILE under `--target standalone` instead of dying with
`u32 out of range: -1`. Test: `tests/issue-2029-subclass-builtin-standalone-emit.test.ts`
(8 compile-success cases). Zero host-mode regressions (the new branch only fires
on the `-1` sentinel, which never occurs in gc/host mode where globals are real).

**Audit of other `stringGlobalMap.get` consumers:** the remaining clusters in
the bucket — `built-ins/Object/create` (74), `Iterator/prototype` (44),
`DisposableStack`/`AsyncDisposableStack` (44), `for-await-of` (23) — all COMPILE
in standalone on current main now (probed: no `-1`/`u32-out-of-range` emit), so
they were either already resolved by later work or never shared this exact
`emitSetSubclassProto` site. The other `stringGlobalMap.get` use sites that
push `global.get` with a `!` non-null assertion (string-ops.ts, object-ops.ts,
literals.ts) are reached only on the **legacy/host** string path (their callers
gate on `!ctx.nativeStrings` or route through `compileNativeStringLiteral` /
`stringConstantExternrefInstrs` in standalone), so they don't hit the sentinel.

**Remaining (separate, NOT this PR):** runtime behaviour of `extends Error`
standalone still leaks the `__new_<Builtin>` HOST import (`class-bodies.ts:1423/2187`)
— a host-import-retirement concern, not the emit crash. Kept #2029 `in-progress`:
the emit-crash cluster (the headline) is fixed; the `__new_<Builtin>` standalone
runtime path is the residual. Reassess closing once that lands.

## Slice (2026-06-18, cs-2160) — `extends Error` standalone `__get_undefined` leak

**Status stays `in-progress`** — one more independent host-import-leak slice.

The `__new_Error` leak noted above was already gone by current main (the WASI
native Error constructor path covers `extends Error`/`TypeError`). The remaining
leak for `class E extends Error {}` standalone was **`env::__get_undefined`** —
the module instantiated FINE in gc/host mode but **failed to instantiate with an
empty import object** standalone (`env: module is not an object or function`),
so the whole subclass cluster produced zero standalone passes.

**Root cause:** three `__get_undefined` emit sites called `ensureLateImport`
DIRECTLY and only fell back to `ref.null.extern` when it returned `undefined` —
but `ensureLateImport` does NOT refuse `__get_undefined` (it's not on any
refusal/native list), so under `--target standalone` it REGISTERED and leaked
the host import; the intended fallback never fired. The canonical
`ensureGetUndefined` (`expressions/late-imports.ts`) already guards on
`ctx.nativeStrings`; the direct sites did not.

**Fix:** mirror the canonical guard at the two reachable direct sites —
`emitUndefinedValue` (`src/codegen/type-coercion.ts`, the `pushDefaultValue`
externref default used by the implicit derived-ctor forwarder) and
`emitBoundsCheckedArrayGetUndef` (`src/codegen/destructuring-params.ts`). When
`ctx.nativeStrings`, skip the import and emit `ref.null.extern` (undefined ≡
null standalone, by design). gc/host mode keeps the host import (the guard is
`nativeStrings`-only). The third site (`calls.ts` padStart/endsWith) is reached
only on the JS-host string path and was left unchanged.

**Validation.** `tests/issue-2029-error-subclass-get-undefined-standalone.test.ts`
(3/3): `extends Error` / `extends TypeError` / `extends Error` with `super(msg)`,
each instantiated with an EMPTY import object (proves no env leak) standalone +
WASI, plus a gc-mode no-regression guard. Existing #2029 subclass-emit suite
(8/8) and standalone string suites green. tsc + prettier + biome lint +
coercion-sites + any-box gates clean. (Pre-existing unrelated failure on main:
issue-1025 nested-pattern test — fails identically on pristine `origin/main`.)

**Still open (the bucket):** TypedArray subclass (`class X extends Uint8Array {}`)
still leaks `__new_<TypedArray>` — needs native vec-struct construction in the
externref-backed implicit forwarder (overlaps #2159). `DisposableStack` /
`AsyncDisposableStack` leak `DisposableStack_new`. Both are separate slices.

## Slice triage (2026-06-21, dev-carla) — DisposableStack/AsyncDisposableStack is SUBSTRATE-BLOCKED, not a dev slice

Probed `new DisposableStack()` standalone: confirmed it leaks `DisposableStack_new`
(and `AsyncDisposableStack_new`) — the constructor + all methods route through the
host `externClasses` table (`src/codegen/index.ts:11134`), no native runtime.

Attempted to scope a native sync-DisposableStack runtime (struct + LIFO disposer
list + use/adopt/defer/dispose/move, modeled on set-runtime.ts). **Blocked on
missing ERM substrate** — measured, not assumed:

1. **`Symbol.dispose` / `Symbol.asyncDispose` value-read is unsupported standalone.**
   `const f = o[Symbol.dispose]` and `o[Symbol.dispose]()` both CE with
   `"Symbol.dispose built-in static property value read is not supported"`. Reading
   a disposer off a resource is the foundational op `use()`/`adopt()`/scope-exit all
   require, so the runtime cannot store or invoke disposers without it.
2. **There is NO native dispose-dispatch helper at all** (`grep __run_disposers /
   __dispose / disposeStack` → 0 hits). Even plain `using r = {[Symbol.dispose](){}}`
   leaks `__box_symbol` and defers the actual disposal to the host runtime — the
   "call Symbol.dispose LIFO at scope exit" primitive is host-backed, not Wasm-native.

The native closure-invoke primitive (`__call_fn_method_N`) DOES exist, so once the
two substrate gaps above land, the runtime itself is a straightforward set-runtime
-style build. But building it now would require first implementing native
`Symbol.dispose` builtin-symbol value-read + a native dispose-dispatch substrate —
foundational ERM/symbol-property-read work that spans the standalone object model,
i.e. senior-dev/value-rep scope (overlaps the #2158 class/descriptor object-model
epic and the symbol-keyed builtin-read path), **not a contained dev slice**.

**Disposition:** DisposableStack/AsyncDisposableStack standalone (the ~44-test
cluster) is **blocked on native ERM substrate** (`Symbol.dispose` builtin value-read
+ dispose-dispatch). DO NOT re-dispatch as a dev slice until that substrate exists.
Route the substrate to senior-dev. No code pushed.

---

## Re-probe + Implementation Plan (2026-06-23, architect)

### The headline `u32 out of range: -1` emit-crash is FIXED on current main

Re-probed every cluster from the original bucket against current main
(`b4ed81215`, `--target standalone`, compile + instantiate, `.tmp/` battery):

| Cluster | Probe | Result on main |
|---|---|---|
| `subclass-builtins` (Error/Uint8Array) | `class X extends Error/Uint8Array {}` | **COMPILES** (no `u32 out of range`) |
| `Object.create` | `Object.create(proto, {…})` | **COMPILES** |
| `Iterator.prototype` | `[1,2,3].values().map(x=>x*2)` | **COMPILES** |

The `emitSetSubclassProto` `-1`-sentinel fix (PR-1, 2026-06-15) + the
`__get_undefined` leak fix (cs-2160) closed the emit-crash. **The bucket's
original failure mode no longer reproduces.** A host-vs-standalone diff over the
three top clusters (sampled) shows the residual is now a *different, smaller* mix
— and most of it is NOT this issue's lane:

| Cluster (sampled) | bothPass | host-only GAP | dominant standalone-fail reason |
|---|---|---|---|
| `subclass-builtins` (36) | 27 | 6 | `compile_error` — **all 6 are `subclass-{Boolean,Number,Map,Set,WeakMap,WeakSet}`** |
| `Object/create` (40) | 7 | 21 | `Cannot convert object to primitive value` (18) — **ToPrimitive / descriptor reflection, value-rep** |
| `Iterator/prototype` (40) | 8 | 17 | `fail` (12, assertion) + a few CEs — **iterator-helper semantics, not emit** |

### Genuinely-open, dev-tractable residual: primitive-wrapper subclass invalid-Wasm

The one cluster squarely in #2029's lane (an emit/compile defect, not value-rep)
is the **6 `subclass-{Boolean,Number,Map,Set,WeakMap,WeakSet}` compile_errors**.
Two distinct dispositions:

1. **`Set`/`Map`/`WeakMap`/`WeakSet` subclass** — already a **loud refusal**
   (#2620: `'class X extends Set' is not yet supported in --target standalone`),
   with the native-subclass substrate tracked in **#2622**. This is the #1888
   dual-mode invariant working as intended (clean CE, never invalid Wasm). NOT a
   new slice — covered by #2620/#2622. The 4 `subclass-{Map,Set,WeakMap,WeakSet}`
   test262 rows stay failing until #2622's native-collection-subclass substrate
   lands; do not re-spec here.

2. **`Number`/`Boolean`/`String` (primitive-wrapper) subclass** — **GENUINE OPEN
   BUG, dev-tractable.** `class N extends Number {}` standalone emits invalid Wasm
   (verified: `wasm-validator error in function N_new: call param types must
   match`, with a `call $__new_Number` whose arg types don't match the native
   `__new_Number` internal). This is the SAME defect class as the native-collection
   case (#2620 defect A/B) but for the primitive wrappers — which are in
   `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` (`builtin-tags.ts:222–224`) and therefore
   take the broken externref-backed `__new_<Wrapper>` host path under standalone
   instead of being refused or natively lowered.

### Root cause (primitive-wrapper subclass)

`collectClassInfo` / the subclass-parent classification in
`src/codegen/class-bodies.ts` (~line 562) has a `nativeStrings` loud-refusal arm
for `isNativeCollectionBuiltin(parentClassName)` (Set/Map/Weak), and an
externref-backed arm for `isHostConstructibleBuiltin(parentClassName)` (~line
583). `Number`/`Boolean`/`String` satisfy `isHostConstructibleBuiltin` (they're
in `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`), so under standalone they enter the
externref-backed arm and `super()`/`new Sub()` lowers to `call $__new_Number` —
but the standalone `__new_Number` internal (the native primitive-wrapper ctor)
has a signature the synthetic `<Class>_new` forwarder doesn't match → the
`N_new: call param types must match` validator failure. No native primitive-
wrapper *subclass* construction exists standalone.

### Changes (Slice — primitive-wrapper subclass: refuse loudly OR native-box)

**File: `src/codegen/builtin-tags.ts`**
- Add a `PRIMITIVE_WRAPPER_BUILTINS = new Set(["Number","Boolean","String"])`
  and an `isPrimitiveWrapperBuiltin(name)` predicate (mirrors
  `isNativeCollectionBuiltin`).

**File: `src/codegen/class-bodies.ts`** (~line 562, the parent-classification
block, BEFORE the `isHostConstructibleBuiltin` arm at ~583)
- **Minimum viable (recommended first slice): loud refusal.** Add an arm
  paralleling the #2620 native-collection refusal: when `parentStructTypeIdx ===
  undefined && ctx.nativeStrings && isPrimitiveWrapperBuiltin(parentClassName)`,
  `reportError` with a clear message (`'class X extends Number' is not yet
  supported in --target standalone — the primitive-wrapper subclass native box is
  not implemented; use Number directly or recompile without --target standalone`)
  and `break` (skip the externref-backed marking). This converts the invalid-Wasm
  crash into a clean, located CE — restoring the #1888 dual-mode invariant. The
  ~2 `subclass-{Number,Boolean}` test262 rows still fail, but **loudly and
  correctly**, and no other standalone program can hit the `N_new` invalid-Wasm.
- **Follow-up (separate, optional slice): native wrapper-box subclass.** A native
  `$Number_wrapper`/`$Boolean_wrapper` struct (primitive value field + class
  `$tag`) so `class N extends Number {}` constructs a real boxed instance with
  `instanceof N`, `.valueOf()`, and the wrapped primitive. This is the
  value-rep-adjacent substrate (pairs with #1629b boxed-primitive work) — route
  to senior-dev / defer; NOT in the minimum-viable slice.

### Wasm IR note
The minimum-viable slice emits NO Wasm — it adds a compile-time refusal before
the broken `call $__new_Number` is ever produced. The defect today is purely
that an unreachable-standalone host path is taken; gating it off restores
correctness with zero runtime surface.

### Lane / blast-radius
- **Standalone/nativeStrings lane only**, gated on `ctx.nativeStrings`. gc/host
  mode is untouched (the externClass host path handles the subclass there, as it
  does for Set/Map). **Not** a value-rep substrate change — a scoped standalone
  compile sweep (the `subclass-builtins` cluster + a gc-mode no-regression
  control) validates it. Not merge_group-broad.
- No overlap with the #1917 coercion cascade. Disjoint files
  (`builtin-tags.ts` / `class-bodies.ts`).

### Acceptance probe
- `class N extends Number {}; new N()` under `--target standalone` produces a
  **clean located CE** (not `wasm-validator error: N_new call param types must
  match`). Same for `extends Boolean` / `extends String`.
- gc/host mode: `class N extends Number {}; new N() instanceof N` still compiles
  and runs `true` (no regression — the guard is `nativeStrings`-only).
- No other standalone program regresses (the new arm fires only on the three
  primitive-wrapper parents under `nativeStrings`).
- New test: `tests/issue-2029-primitive-wrapper-subclass-standalone.test.ts` —
  asserts the three refusals are clean CEs standalone + the gc-mode control.

### Disposition for the rest of the bucket (NOT dev-tractable here)
- **`Set`/`Map`/`WeakMap`/`WeakSet` subclass** → #2620 (refused) / #2622 (native
  substrate). Already tracked; do not re-slice.
- **`Object.create` `Cannot convert object to primitive value`** (the dominant
  standalone gap, ~18/40 sampled) → standalone **ToPrimitive over a descriptor
  object** + `propertyHelper.js`/`verifyProperty` descriptor reflection. This is
  the #2358/#2158 value-rep / object-model substrate, NOT an emit bug. Defer.
- **`Iterator.prototype` `fail`** → iterator-helper (`map`/`filter`/`drop`/`take`)
  *semantics* assertions, not emit. Separate conformance lane (#1472/iterator
  helpers), not #2029.

### Recommended issue status
The `u32 out of range` emit-crash headline (the 497-test bucket's defining
failure) is **resolved**. The remaining in-lane work is the single
primitive-wrapper-subclass slice above; everything else has migrated to other
substrates (#2620/#2622, #2358/#2158, iterator-helpers). After the
primitive-wrapper slice lands, #2029 can close as **done** (the emit-crash class
is gone) with a pointer to the migrated trackers, OR stay open solely as the
umbrella for the primitive-wrapper native-box follow-up — PO/lead call.
