---
id: 2029
title: "standalone: `Binary emit error: u32 out of range: -1` on builtin subclassing, disposal protocol, Object.create, Iterator.prototype (497 tests)"
status: done
completed: 2026-07-04
sprint: 71
created: 2026-06-10
updated: 2026-07-13
priority: critical
assignee: ttraenkler/fable-2029
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

## Slice LANDED (2026-06-24, sdev-pwrap) — primitive-wrapper subclass loud refusal

Applied the architect's minimum-viable slice. **Re-grounded against current main
(`064b27657`) first:** `class N extends Number {}` / `extends Boolean {}` under
`--target standalone` still emit invalid Wasm — confirmed the exact diagnosed
failure: `Compiling function "N_new" failed: call[0] expected type f64, found
local.get of type externref`. `class S extends String {}` already compiles +
instantiates + `instanceof` works standalone (String's
`__new_String(externref)->externref` matches the externref forwarder), so it is
deliberately NOT refused.

**WHY a refusal, not a native box:** the externref-backed forwarder passes the
subclass instance externref to `call $__new_Number`, but the standalone
`__new_Number`/`__new_Boolean` internals take an **f64** primitive value. There
is no native primitive-wrapper *subclass* box (a `$Number_wrapper` struct
carrying the primitive + class `$tag`) standalone yet — that's the value-rep
follow-up (pairs with #1629b). Routing through the host path is the bug; gating
it off **before** the broken `call` is emitted restores the #1888 dual-mode
invariant (clean located CE, never invalid Wasm) with zero runtime surface.

**Downstream-effect audit (no stack/index/return-type fallout):** the new arm is
a pure compile-time `reportError` + `break` placed BEFORE the
`isHostConstructibleBuiltin` marking — it adds no Wasm instructions, no
late-import, no struct/type/global registration, so it cannot perturb stack
balance, funcIdx/typeIdx shifting, or return types. It fires only when ALL of
`parentStructTypeIdx === undefined && ctx.nativeStrings &&
isPrimitiveWrapperSubclassUnsupported(parent)` hold — i.e. only a standalone/wasi
subclass of `Number`/`Boolean`. gc/host mode (`!nativeStrings`) is untouched (the
externClass host path still handles the subclass and the gc-mode control test
proves `instanceof` still works `true`). `String` is excluded from the set, so
the one working standalone wrapper-subclass case is preserved (asserted: empty
`env::` imports + instantiates + `instanceof` → 1).

**Files:** `src/codegen/builtin-tags.ts` (add
`PRIMITIVE_WRAPPER_SUBCLASS_UNSUPPORTED = {Number, Boolean}` +
`isPrimitiveWrapperSubclassUnsupported`); `src/codegen/class-bodies.ts` (refusal
arm in `collectClassDeclaration`, mirrors the #2620 native-collection arm).

**Validation.** `tests/issue-2029-primitive-wrapper-subclass-standalone.test.ts`
(7/7): Number/Boolean refuse loudly standalone + wasi (clean CE, no invalid
Wasm), still compile in gc mode, and String still compiles+instantiates+
`instanceof` standalone with no env leak. Existing #2029 suites green:
`issue-2029-subclass-builtin-standalone-emit` (8/8) +
`issue-2029-error-subclass-get-undefined-standalone` (3/3) — no regression.

**Status stays `in-progress`** pending PO/lead call on close-vs-umbrella (the
native wrapper-box subclass is the only residual, a deferred value-rep slice).
The 4 `subclass-{Map,Set,WeakMap,WeakSet}` rows remain on #2620/#2622; the
`Object.create` ToPrimitive gap on #2358/#2158; iterator-helper semantics on the
iterator-helpers lane. None are emit bugs.

---

## Regrounded against current main (2026-06-25, sd-2038) — bucket is 37, not 497

Measured the **live** standalone baseline (`test262-standalone-current.jsonl`,
refreshed per-push) rather than trusting the original 497/`u32 out of range`
framing:

- The headline error string **`u32 out of range: -1` now matches 0 tests.** The
  #2043 always-on emit validation renamed it to located `… index out of range`
  errors, and the prior LANDED slices (emitSetSubclassProto -1 guard,
  `__get_undefined` leak, primitive-wrapper refusal — all on main, not stranded)
  closed the original crash. The 497→**37** reduction is real.
- **True current residual: 37 tests** with `index out of range`, confirmed by
  running the actual runner (`runTest262File(..., "standalone")`) over all 37 —
  every one still crashes with the FULL harness wrap (`L2:1`); naive single-file
  probes compile because they lack the harness shape.

Three independent producer sub-buckets (separate PRs, per lead):

| Kind | Count | Cluster | Class |
|---|---:|---|---|
| `local index`    | 12 | template-literal `tv-*` (9) + tagged-template (2) + for-of iterator-next (1) | speculative-rollback localMap (THIS PR) |
| `global index -1`| 17 | SuppressedError (12), DisposableStack/AsyncDisposableStack proto, String.replaceAll, Error.isError, property-accessors | `-1` string-global sentinel (next PR) |
| `function index` | 8 | TypedArray/Array `toLocaleString`, annexB RegExp, optional-chaining async | funcIdx late-shift (#1809/#1839; may split to own issue) |

7-line local-index repro (`local index out of range — 5 (valid:[0,2))`):
```ts
export function test(): number {
  var calls = 0;
  (function (s: any) { calls++; })`foo`;  // tagged template, tag = closure capturing outer `calls`
  return calls;
}
```

## LANDED slice (2026-06-25, sd-2038) — local-index cluster (11/12 of the sub-bucket)

**Root cause (verified per-process, NOT the diagnostic's default #2043
attribution).** Every `compileExpression` runs inside a speculative
snapshot/rollback (`snapshotSpeculative`/`rollbackSpeculative`, #1919). While the
tagged-template lowering compiles the IIFE tag, closure-capture boxing
**re-points the captured outer local in `fctx.localMap`**
(`localMap.set("calls", boxedSlot)`, closures.ts). When the enclosing expression
rolled back, `restoreLocals` (#1847) snapshotted only the localMap **key set** and
therefore only DELETED names the probe ADDED — it never RESTORED a re-pointed
**existing** name. So `calls` kept pointing at the truncated box slot (5), and
the later `return calls` emitted `local.get 5` past the function's 2-local count
→ emit crash. (Traced: at the tag-template entry fctx had
`[calls,__tt_strings_1,__tt_raw_data_2,__tt_raw_vec_3,__tt_arr_data_4]`; after
rollback `[calls,__ng_1]`, but the body kept `local.get#5`.)

**Fix (in the snapshot/restore layer, `src/codegen/context/locals.ts` — not a
local patch in the tagged-template handler, per lead guidance):**
`snapshotLocals` now records the full localMap **entries** (name→slot) plus the
`boxedCaptures` key set; `restoreLocals` rebuilds `localMap` exactly (clear +
re-insert snapshot entries — dropping added names AND resetting re-pointed ones)
and drops probe-added `boxedCaptures` markings (a stale box marking would make a
post-rollback read deref a truncated ref-cell). Near-O(1), hot-path-safe (locals
are tiny). gc/host mode and all non-rollback paths are unaffected.

**Validation.** `tests/issue-2029-tagged-template-capture-local-index.test.ts`
(5/5: compiles standalone, captured local reads back `7` at runtime, +subs,
two-tag tv-template-head shape, gc-mode control). The 37-file runner re-probe:
**11 flipped** from `index out of range` → no longer an emit crash (the
template-literal/tagged-template cluster). Closure/tagged-template regression
suites (`illegal-cast-closures-585`, `issue-1712-capture-closure-dispatch`,
`iife-tagged-templates`) show 8 pre-existing failures that are **identical on
pristine `origin/main`** (verified in a clean baseline worktree) — not
regressions. tsc clean. Broad emit-path change → relying on the merge_group
test262 floor for full conformance (per `project_broad_impact_validate_full_ci`).

**Remaining (separate PRs, this issue stays `in-progress`):** the `global index
-1` sentinel cluster (17) and the `function index` funcIdx-shift cluster (8), plus
1 stray `for-of/iterator-next-reference` local-index from a different producer.

## LANDED slice (2026-06-25, sd-2038) — global-index `-1` sentinel cluster (14 off the emit-crash)

Two distinct producers in the global-index `-1` sentinel sub-bucket, both the
documented `-1` string-global-sentinel class (a string constant un-materialized
standalone records `-1` in `stringGlobalMap`; a raw `global.get` of it crashes
the encoder):

1. **`SuppressedError.prototype.<member>`** — `SuppressedError` was missing from
   `BUILTIN_CTOR_NAMES` (`property-access.ts`), so the read fell through both the
   standalone native-proto path and the host `__get_builtin` fallback into a
   generic member path that pushed a raw `global.get <stringGlobalMap.get>`.
   **Fix:** list `SuppressedError` in `BUILTIN_CTOR_NAMES` — identical to the
   DisposableStack/AsyncDisposableStack precedent already there. Routes the read
   to the dual-mode handler (clean located refusal standalone, `__get_builtin`
   under gc/host). Flips the 7 `built-ins/SuppressedError/prototype/*` rows off
   the emit-crash (now clean CE).

2. **ERM ctors read as bare VALUES** (`Object.getPrototypeOf(SuppressedError)`,
   `isConstructor(DisposableStack)` — `proto.js` / `is-a-constructor.js` for all
   three ERM ctors, 6 rows) — `identifiers.ts` had a HOST-ONLY fast path for
   `DisposableStack`/`AsyncDisposableStack`/`SuppressedError`-as-value that called
   `__get_globalThis` + `__extern_get` and pushed the ctor-name key via the `-1`
   string-global sentinel → `global.get -1`. It was NOT standalone-gated, so it
   both baked the bad index AND leaked two host imports an empty import object
   can't satisfy. **Fix:** gate the fast path to gc/host (`!standalone && !wasi`);
   standalone falls through to the clean path. (This is why the already-listed
   DisposableStack pair STILL had a `proto`/`is-a-constructor` residual — listing
   in `BUILTIN_CTOR_NAMES` covers `.prototype.*` but not the bare-value path.)

**Row-delta:** the 37-file runner re-probe (post-#2052 baseline 26 still-crashing)
→ **12 still-crashing**: 14 flipped off the emit-crash, 1 now PASSES outright.
gc/host mode unchanged (the value fast-path still fires in gc; verified
`Object.getPrototypeOf(SuppressedError)` compiles gc). Files:
`src/codegen/property-access.ts` (+SuppressedError in BUILTIN_CTOR_NAMES),
`src/codegen/expressions/identifiers.ts` (host-gate the ERM-ctor value fast-path).
Test: `tests/issue-2029-suppressederror-builtin-global-sentinel.test.ts` (6/6).
Existing #2029 suites green (23/23). Broad emit-path change → merge_group floor.

**Remaining global-index (3, separate/deferred producers):** `String.prototype.
replaceAll/searchValue-replacer-RegExp-*` (2, regexp-replacer string key) and
`language/expressions/property-accessors/S11.2.1_A3_T2.js` (1, getter/setter
accessor). Plus the `function index` funcIdx-shift cluster (8: TypedArray/Array
`toLocaleString`, annexB RegExp, optional-chaining async) and 1 stray
`for-of/iterator-next-reference` local-index — the next PR(s).

## LANDED slice (2026-06-25, sd-2029fn) — function-index cluster (failed-nested-hoist strands object-runtime helpers)

**Root cause — NOT dead-elimination (sd-2038's hypothesis was disproved by the
per-process trace).** The characterized repro
(`built-ins/Array/prototype/toLocaleString/user-provided-tolocalestring-grow.js`,
`call 136` into a 129-func module at `__call_m_resize_1`) was traced emit-time:

- At `fillClosedMethodDispatch`, `funcMap.get("__extern_method_call")` returned
  **136 while the local table held only 132 funcs** — i.e. the funcMap entry was
  ALREADY stale at fill time (delta exactly = the 4 dead imports? no — the delta
  was the count of object-runtime helpers truncated below; see trace). The helper
  named `__extern_method_call` had `actualTablePos = -1` — it was **not in
  `mod.functions` at all** (along with `__apply_closure`, `__object_seal/freeze`,
  and all 16 `__proxy_*` dispatchers — 30 orphaned funcMap entries pointing past
  the table).
- The orphan source: **`hoistFunctionDeclarations`** (`nested-declarations.ts`).
  The test's `listToString` nested `function` declaration FAILS to hoist (its body
  hits `__extern_toLocaleString`, standalone-unsupported → `reportError`). During
  that failed compile it had pulled in the **entire object runtime** as a side
  effect (86 funcs registered in `mod.functions` AND `funcMap`, plus
  `objectRuntimeTypes` / a late import). The rollback did
  `ctx.mod.functions.length = funcsBefore` — truncating those 86 helpers out of
  the table — **but left their `funcMap` entries and the `objectRuntimeTypes` /
  `ensureProxyRuntime` (`funcMap.has`) guards intact.** A later real
  `rab.resize(...)` any-receiver call reserved `__call_m_resize_1`; its
  `ensureObjVecBuilders` → `ensureObjectRuntime` found `objectRuntimeTypes` SET,
  SKIPPED re-registration, and `fillClosedMethodDispatch` baked the stale funcIdx
  (136) past the shrunken table → the encoder's "function index out of range".

This is a NEW instance of `project_type_index_shift_and_deadelim`'s sibling for
the **local function table**: `src/codegen/context/speculative.ts` (#1919) makes
expression probes transactional over imports/funcMap, but the older
nested-function-hoist rollback truncated `mod.functions` WITHOUT the matching
side-table unwind.

**Fix (`src/codegen/statements/nested-declarations.ts`, the failed-hoist
rollback): do NOT truncate `ctx.mod.functions`.** The side-effect helpers are
valid, content-addressed, idempotent, and potentially needed by later code —
removing them is the over-reach. Instead keep every pushed func and neutralise
ONLY the failed user function's own entry to a valid `unreachable` stub (local
funcs are never dead-eliminated, so a leftover MUST be valid Wasm, not an empty /
broken body), dropping its funcMap name so `compileStatement` re-compiles it at
its real textual position (the pre-existing `hoistFailedFuncs` re-attempt). funcMap
and the table stay in lockstep — no dispatcher can bake a stale index.

**Why not "complete the truncation" (purge funcMap + reset `objectRuntimeTypes`
→ re-register)?** Tried and REJECTED: the object runtime's own dependencies
(`number_toString`, native-string helpers, union boxes) have separate
registration latches that would ALSO need resetting in dependency order — a
re-register-after-purge crashed a probe with `function index out of range —
undefined at __to_property_key` (a purged dep baked as `undefined`). Keeping the
helpers (no truncation) sidesteps the entire cascading-latch problem.

**Downstream-effect audit:** the change is in the mode-agnostic hoist, but the
truncation only ever stranded the standalone-only object-runtime/closed-method
helpers (gc/host never reserves a dispatcher), so the stale-index crash was
standalone-only and the fix is too. No stack-balance / return-type / index-shift
fallout: the only behavioural delta is "a failed-hoist leftover func is an
`unreachable` stub instead of being spliced out", and that func is unreferenced
(dead) — `reservedEntry.body = []` (invalid for non-void returns) is now
`[unreachable]` (strictly safer).

**Row-delta (paired scan, my branch vs pristine, identical on the 3 touched
files):** `built-ins/{Array,TypedArray}/prototype/toLocaleString` — **5 →
0** `function index out of range` emit-crashes (now reach a downstream
`__closure_5` instantiate type-mismatch / `Cannot convert object to primitive` —
SEPARATE bugs, not emit crashes). optional-chaining: 0 funcidx crashes on both
(`member-expression-async-this` PASSES; others runtime-fail, not emit-crash). No
regression anywhere (annexB unchanged; see residual).

**Validation:** new `tests/issue-2029-nested-hoist-funcidx-standalone.test.ts`
(3/3) — proven to FAIL on pristine (2 standalone cases emit-crash) and PASS on
this branch, plus a gc-mode no-regression control. tsc clean. Hoist/closure/2029
suites: 59/59 tests pass (matches pristine; the cross-suite "failed file"
collection noise is identical on pristine). #2151 / #2015 / #2038 / generator /
standalone-coercion batch green. Broad emit-path change → relying on the
merge_group test262 floor for full conformance
(`project_broad_impact_validate_full_ci`).

**Remaining function-index (separate producer, NOT this fix, PRE-EXISTING — out
of traced scope):** `annexB/built-ins/RegExp/RegExp-{control-escape-russian-letter,
invalid-control-escape-character-class}.js` (2) crash with `function index out of
range — undefined at <generator fn>` — a `function* …()` native-generator funcMap
lookup baking `undefined`, confirmed IDENTICAL on pristine (neither fixed nor
regressed here). A distinct funcMap-returns-undefined producer in the
generator-native lowering; route as its own slice. Plus the global-index
regexp-replacer (2) + property-accessor (1) and the for-of/iterator-next
local-index (1) residuals already noted above.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — umbrella; the headline `u32 out of range: -1` emit-crash class IS resolved (497 → a handful; multiple landed slices: emitSetSubclassProto -1 sentinel, __get_undefined leak, primitive-wrapper refusal, tagged-template localMap rollback, SuppressedError global-sentinel, failed-nested-hoist funcIdx). Remaining separate producers: regexp-replacer global-index (2), property-accessor (1), native-generator funcMap-undefined in annexB RegExp (2), one for-of/iterator-next local-index (1). Deferred: primitive-wrapper native-box subclass; DisposableStack/AsyncDisposableStack ERM substrate (Symbol.dispose value-read + dispose-dispatch, senior-dev). Stays in-progress as the umbrella.

## FINAL family map + fixes (2026-07-04, fable-2029) — emit-crash class now ZERO

**Measured first (live standalone baseline `test262-standalone-current.jsonl`,
2026-07-03 refresh, confirmed per-process on main `f01867968` via
`runTest262File`):** the bucket was down to **4 tests, 3 producer families**.
The annexB native-generator `funcMap`-undefined pair (2) had already flipped to
ordinary semantic `fail`s (fixed by intervening work — no longer emit-crashes).
Notably, none of the 4 was host-PASS anymore, and family A crashed in **BOTH
modes** — the original "host-pass gap" framing was stale.

| Family | Tests | Producer (verified per-process, minimized) | Fix |
|---|---|---|---|
| **A** `local index out of range — 2 (valid:[0,2)) at '__anon_0_get_next'` (BOTH modes) | for-of/iterator-next-reference.js | The **Object.defineProperty descriptor accessor path** (`object-ops.ts` ~1927) compiled `get(){...}` bodies in a fresh fctx **without ever calling `promoteAccessorCapturesToGlobals`** (the object-literal accessor path in literals.ts has always called it). A getter returning a nested fn (`get(){ return next; }`, `function next()` capturing an enclosing local) materialized next's closure via `cap.outerLocalIdx` — a slot of the ENCLOSING function — baked into the accessor body: emit crash when out of range, **silent wrong-local read when in range**. Minimal repro needs a preceding computed-member fn-expr assignment only to shift the slot out of range. | (1) `object-ops.ts`: call `promoteAccessorCapturesToGlobals` for descriptor get/set bodies (after the S5c closure arm). (2) `closures.ts promoteAccessorCapturesToGlobals`: NEW phase — promote **transitive captures of referenced nested functions** (value global for immutable — value-copy semantics preserved since never written; eager ref-cell box aliased in a `(ref null $cell)` module global — `ctx.capturedBoxGlobals` — for mutable, giving LIVE write-through sharing). (3) `closures.ts emitMemoizedNestedFnClosure` + the calls.ts direct-call cap-prepend: new sourcing arms — prefer `capturedBoxGlobals` / `capturedGlobals` when the current fctx cannot resolve the capture (guarded on localMap-absence; owner-fctx behavior unchanged, respecting the #1177 revert). Mutable-but-directly-referenced keeps value promotion + a boxed copy at materialization (best-effort, documented). |
| **B** `global index -1 at 'RE_@@replace'` (standalone) | replaceAll/searchValue-replacer-RegExp-call{,-fn}.js | `emitSuperExternMethodCall` (`new-super.ts:356`) — the #1614 JS-host super-dispatch bridge (`__extern_method_call`) — ran under standalone and pushed the method name via raw `global.get stringGlobalMap.get(name)` guarded only on `!== undefined` — the documented **-1 string-global sentinel class** (`reference_string_global_sentinel_guard`), missed by PR-1's audit because it's the *super* path, not a direct `stringGlobalMap` consumer of that sweep. Minimal repro: ANY `super.method(...)` in a subclass of a host-constructible builtin, standalone. | Gate the bridge off under `ctx.standalone || ctx.wasi` (host bridge can never be satisfied there; also stops the `__extern_method_call`/`__js_array_*` import leak) + route the name push through `stringConstantExternrefInstrs` for the gc+nativeStrings combination (host byte-identical). |
| **C** `global index -1 at 'test'` (standalone) | property-accessors/S11.2.1_A3_T2.js | **Three layers** in the ELEMENT-ACCESS number-method arm (calls.ts ~15207), minimized to `1["toFixed"](5)`: (i) the RangeError message pushes used the raw -1-sentinel `global.get` (the dot-access twins already used the dual-mode helper); (ii) the declarations.ts pre-scan (`collectPrimitiveMethodImports`) only recognizes the DOT form, so `number_toFixed` etc. were never registered for the computed spelling → the arm fell through past `funcMap.get(...)` **with receiver+arg already pushed** into the generic dynamic fallback (runtime throw); (iii) the arm validated `toString(radix)` then called the 1-arg helper — radix silently dropped (`5["toString"](2)` → "5"). | (i) `stringConstantExternrefInstrs` at both message sites; (ii) new elem-access string-key branch in the declarations.ts scan registering the same helpers; (iii) hoist `radixLocal` and route to the 2-arg `number_toString_radix` mirroring the dot site. All computed forms (`toFixed`/`toPrecision`/`toExponential`/`toString(radix)`) now compute CORRECT values standalone (verified runtime, empty import object). |

**Classification verdicts (the assignment's a/b/c ruling):** none of the three
families was dying on its own via #2710's late-binding migration (the
`ref.func` in family A's body was already a healthy `STABLE_FUNC_BASE`
late-bound id — the poison was the *local* index); all three were bounded
fixes and all three are FIXED in this PR. The annexB generator pair (the one
family sd-2029fn left) had already died via intervening work.

**Row-delta (per-process, branch vs pristine `f01867968`):** all 4 tests ×
both modes: emit-crash → compiles + ordinary runtime `fail` (dynamic-object
iterator protocol / RegExp-subclass ctor flags / number-member spelling gaps —
separate, pre-existing families, host-mode parity). **The `index out of
range` emit-crash count in the standalone baseline is now 0.**

**Validation:** new `tests/issue-2029-emit-index-families.test.ts` (8/8; A
gc+standalone compile, B no-crash + no `__extern_method_call` leak +
gc control, C standalone runtime-correct + gc control). All 7 existing
issue-2029 suites green (37/37). Closure/accessor batch
(illegal-cast-585, 1712, getters-setters, accessor-side-effects, 2580, 2609,
2692, 1528): 13 failures **identical on pristine** (verified in a clean
control worktree) — pre-existing, not regressions. Number-format suites
(49, 2163, 2934): 23/23. tsc clean; stack-balance / any-box / speculative-
rollback gates OK; coercion-sites baseline refreshed (+2 in declarations.ts =
pre-registration of EXISTING native helpers for the elem-access spelling,
same pattern as the counted dot-form block — not new coercion vocabulary).
Broad emit-path change → merge_group test262 floor validates full conformance
(`project_broad_impact_validate_full_ci`).

**Why status: done.** The issue's defining class — invalid-binary emission
from a poisoned index — is extinct on the measured baseline: every producer
family is fixed or refuses loudly, and #2043's always-on validation turns any
future regression into a named, located error. The remaining non-emit
residuals live on their own trackers per the 2026-06-23 disposition:
Set/Map/WeakMap/WeakSet subclass → #2620/#2622; primitive-wrapper native-box →
value-rep follow-up (pairs #1629b); Object.create ToPrimitive/descriptor
reflection → #2358/#2158; iterator-helper semantics → iterator-helpers lane;
DisposableStack/AsyncDisposableStack ERM substrate (Symbol.dispose value-read
+ dispose-dispatch) → senior-dev substrate slice (dev-carla triage above).
Known small residual noted for a follow-up, NOT emit-crash: the elem-access
number-method arm still falls through with a dirty stack if a helper is
somehow unregistered (unreachable for the scanned shapes), and a
directly-referenced + mutably-closure-captured accessor variable gets copy
(not shared) semantics — both documented inline at the sites.
