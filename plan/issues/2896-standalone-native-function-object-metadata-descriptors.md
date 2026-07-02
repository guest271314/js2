---
id: 2896
title: "Standalone: native function-object metadata + property descriptors (.name/.length, getOwnPropertyDescriptor) — blocks builtin static-method value-read cluster"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-f1
created: 2026-06-30
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
goal: standalone
horizon: xl
related: [2861, 2863, 2175, 2193]
umbrella: 2860
spec: ready
---

# Standalone: native function-object metadata + property descriptors

## Problem

In `--target standalone`, the native function/method-closure value objects
(`$NativeMethodClosure` / builtin static-method closures materialized by
`ensureStandaloneBuiltinStaticMethodClosure`, `ensureStandaloneNativeMethodClosure`)
do **not** carry faithful function-object metadata:

- `fn.name` does not resolve to the spec name (returns `0`/empty).
- `fn.length` does not resolve to the spec arity (folds to `0`).
- `Object.getOwnPropertyDescriptor(fn, "name" | "length")` returns nothing
  (the reflective descriptor path sees no property), so the standard
  attributes `{ writable:false, enumerable:false, configurable:true }` are
  not observable.

This is true **even for already-wired methods** (verified against the control
`Array.isArray`, which has a registered static closure):

| read (standalone)                                  | result |
| -------------------------------------------------- | ------ |
| `typeof Array.isArray === "function"`              | ✅ 1   |
| value-call `let f = Array.isArray; f([1,2])`       | ✅ 1   |
| `new (Array.isArray)()` throws (not-a-constructor) | ✅ 1   |
| `Array.isArray.name === "isArray"`                 | ❌ 0   |
| `Array.isArray.length === 1`                       | ❌ 0   |
| `[[1],2].filter(Array.isArray)` (pass as callback) | ❌ 0   |
| `getOwnPropertyDescriptor(Array.isArray,"name")`   | ❌ 0   |

## Why it matters

test262's `propertyHelper.js` (`verifyProperty`) — used by essentially every
builtin's `name.js`, `length.js`, and `prop-desc.js` — reads metadata through
the **reflective** path `Object.getOwnPropertyDescriptor(fn, "name")` and checks
the full attribute set, NOT a direct `fn.name === "x"` access. Because the
native closures expose no descriptor-visible `name`/`length` property, those
tests fail (or CE) regardless of any direct-access meta-fold.

This is the substrate blocker behind the **builtin static-method value-read
cluster** (#2861 residual / #2863 Phase 1): direct _calls_ of builtin static
methods already work host-free (`Number.isInteger(5)`, `ArrayBuffer.isView(...)`),
and bare value-reads can be wired per-method — but per-method wiring flips only
the `not-a-constructor.js`-style test each, while `name.js`/`length.js`/
`prop-desc.js` (the bulk per builtin) stay red until the function-object
metadata/descriptor substrate exists.

## Scope (BROAD SHARED INFRA — not per-method wiring)

This is **shared infrastructure**, deliberately filed separately from the
per-builtin value-read wiring in #2861/#2863:

- Native function/closure values need a uniform, descriptor-visible
  `name` (string) and `length` (number) with the spec attributes
  (`writable:false, enumerable:false, configurable:true`).
- `getOwnPropertyDescriptor` / `getOwnPropertyNames` over a native function
  value must surface these own properties.
- Callback-passing of a native method value must invoke it correctly
  (the `filter(Array.isArray)` control returns 0 today).
- Overlaps the existing direct-access meta-fold
  `tryCompileStandaloneBuiltinProtoMemberMeta`
  (`src/codegen/property-access.ts:861`), which folds
  `<Builtin>.prototype.<member>.name`/`.length` to constants but does NOT
  satisfy the reflective descriptor path (verified: the descriptor read still
  returns 0 for `String.prototype.charAt.name`). The substrate fix should
  subsume / align with that fold rather than duplicate it.

## Where to look

- `src/codegen/property-access.ts`:
  - `ensureStandaloneBuiltinStaticMethodClosure` (line ~954) — static-method
    closures (only `Array.isArray`, `Object.keys`,
    `Object.getOwnPropertyDescriptor` wired).
  - `ensureStandaloneNativeMethodClosure` / `tryEnsureNativeProtoBrand`
    (line ~704) — brand-keyed proto method/getter closures.
  - `tryCompileStandaloneBuiltinProtoMemberMeta` (line ~861) — existing
    direct-access `.name`/`.length` fold (does not cover descriptors).
  - `makeBuiltinClosureFctx` (line ~644) — the closure struct shape; a
    `name`/`length` carrier would attach here.
- The standalone `$Object` / native value-read substrate for how an externref
  function value answers `getOwnPropertyDescriptor` / member reads.

## Acceptance

- `Object.getOwnPropertyDescriptor(fn, "name")` / `(fn, "length")` over a native
  builtin function value returns the spec value + `{writable:false,
enumerable:false, configurable:true}`.
- test262 `built-ins/**/{name,length,prop-desc}.js` flip to **pass** host-free
  for the wired builtin functions (and unblock the #2861/#2863 static-method
  value-read cluster once individual methods are wired).
- Passing a native method value as a callback invokes it correctly.
- gc (JS-host) mode unchanged; standalone-gated; full `merge_group` +
  standalone high-water, net-positive, zero host-mode regression.

## Notes

Filed from the 2026-06-30 verify-first sweep (sr-genframe) that concluded the
cheap ungated host-free CE→pass lane is near-exhausted and the standalone gap is
now substrate-bound. **feasibility: hard — needs an architect spec before dev
work** (function-object metadata model + descriptor visibility over the
standalone value substrate). Do not pick up as a bare per-method wiring task.

---

## Implementation Plan (sr-fnmeta, 2026-06-30 — verify-first + spec)

**Status of this issue after this pass:** verify-first measurement + mechanism
trace + implementation spec done. **No code shipped** — the substrate is **XL**
(runtime descriptor visibility on function values) and the budget window was at
~14% when this was picked up; starting the build would strand a half-migrated
closure-struct shape at the window freeze. Spec'd for a fresh-budget window per
the rolling-budget rule. `horizon: xl`, `spec: ready`.

### Verify-first measurement (current `main`, `--target standalone`)

Deterministic sample of **180 / 1836** `built-ins/**/{name,length,prop-desc}.js`
tests (every ~10th, sorted) run through the real runner (`runTest262File(...,
"standalone")`):

| status          | count |
| --------------- | ----- |
| pass            | 81    |
| **fail**        | 35    |
| **compile_err** | 12    |
| skip            | 52    |

→ **~37 % of non-skip** name/length/prop-desc tests fail on standalone
(47/128). Extrapolated to the full 1836-file corpus that is **≈480 fail/CE**.
Not all are unblocked by THIS issue alone — many (`Atomics/and/length.js`,
`Number/isNaN/length.js`, `TypedArray/prototype/at/name.js`) first need the
function **value-read** itself wired host-free (#2861/#2863). The subset THIS
issue directly unblocks = function values **already producible host-free** whose
**metadata fails reflectively**: the wired static method (`Array.isArray`) + the
broad set of proto-method value-reads already wired via `tryEnsureNativeProtoBrand`
(String/Array/Number/Date/RegExp/TypedArray/Map/Set/Error/… prototypes). That
directly-addressable slice extrapolates to **≈250–360 tests**; it is also the
hard gate in front of every per-method value-read flip in #2861/#2863 (each of
those flips only `not-a-constructor.js` until this lands).

### Mechanism — confirmed on the `Array.isArray` + proto-method controls

Direct probes (`.tmp/mech*.mts`, host-free unless noted):

| read (standalone)                                     | today                    | want         |
| ----------------------------------------------------- | ------------------------ | ------------ |
| `typeof Array.isArray === "function"`                 | ✅                       | ✅           |
| `Array.isArray.name === "isArray"` (direct)           | ✅                       | ✅           |
| `Array.isArray.length === 1` (direct)                 | ❌ 0                     | ✅           |
| `String.prototype.charAt.name/.length` (direct)       | ✅                       | ✅           |
| `Object.getOwnPropertyDescriptor(fn,"name").value`    | ❌ und                   | ✅           |
| `Object.getOwnPropertyDescriptor(fn,"length").value`  | ❌ und                   | ✅           |
| `fn["name"]` dynamic (computed key)                   | ❌ **leaks host import** | ✅ host-free |
| `Object.prototype.hasOwnProperty.call(fn,"name")`     | ❌ 0                     | ✅           |
| `Object.getOwnPropertyNames(fn)` includes name/length | ❌                       | ✅           |
| `[[1],2].filter(Array.isArray)` (callback)            | ❌ 0                     | ✅           |

**Root cause (two distinct gaps):**

1. **No metadata on the value.** A native function value is a _closure wrapper
   struct_ (`getOrCreateFuncRefWrapperTypes` → field 0 = the funcref;
   `makeBuiltinClosureFctx` builds the static/proto builtin closures). It carries
   **no name/length**. The `.length` direct read in
   `src/codegen/dyn-read.ts` (`closureBaseWrapperTypeIdxs`, the closure arm of
   the `.length` chain, ~line 291) deliberately returns a **flat `box_number(0)`**
   ("arity not statically tracked → match origin's prior numeric 0"). That is why
   `Array.isArray.length` is 0. `.name` direct works only via the separate
   compile-time meta-fold `tryCompileStandaloneBuiltinProtoMemberMeta`
   (`property-access.ts:861`) and the static-name fold — **neither is reflective**.

2. **GOPD/`__extern_get`/`hasOwnProperty`/`getOwnPropertyNames` don't recognise
   function values.** `__getOwnPropertyDescriptor`
   (`src/codegen/object-runtime.ts:5552-5697`) does
   `any.convert_extern(obj); ref.test $Object; if !$Object → return undefined`.
   A closure wrapper struct is **not** `$Object`, so it falls straight through to
   `undefined`. The corpus path is **runtime, not syntactic**: test262's
   `propertyHelper.js → verifyProperty(obj, name, desc)` reads
   `__getOwnPropertyDescriptor(obj, name)` / `__hasOwnProperty(obj, name)` /
   `obj[name]` / `isEnumerable(obj, name)` where `obj`/`name` are **parameters**
   (runtime values) — so a compile-time syntactic fold at the GOPD call site
   **cannot** satisfy it (confirmed: the receiver is never a literal at the GOPD
   site inside `verifyProperty`). It genuinely requires the function value to
   answer descriptors **at runtime**.

### Why this is XL, not a bounded slice

A faithful, per-function `.name`/`.length` answered at runtime requires the
metadata to be **carried on the value** (or a per-type runtime dispatch). There
is no host-free shortcut: the direct meta-folds already pass `.name`/`.length`
for proto methods, yet `verifyProperty` still fails because it goes through the
**reflective** GOPD path. So the win requires touching the **value
representation** + **every reflective runtime native** that inspects it. That is
broad shared infra (the issue's own framing), and changing the closure struct
shape is historically regression-prone (index/funcidx shifts, shared-`Instr`
double-remap — see the memory notes). Do it as one designed migration, not a
patch.

### Recommended architecture — standalone-gated metadata-carrying builtin closure

Constraint: **gc bytes MUST be unchanged**. Therefore do **not** widen the
shared user-closure wrapper struct. Two viable shapes (pick at build time;
**Option A preferred** for containment):

- **Option A (preferred) — dedicated `$BuiltinFn` carrier struct.** Introduce a
  single new standalone-only struct
  `$BuiltinFn { funcref $fn; externref $name; i32 $length; i32 $flags }`
  (flags = the fixed `{writable:false, enumerable:false, configurable:true}` for
  name/length — a constant, but kept as a field for uniformity / future
  `bind`/user-fn reuse). Builtin **static** and **proto-method** closures
  (`ensureStandaloneBuiltinStaticMethodClosure` ~954,
  `ensureStandaloneNativeMethodClosure`) `struct.new` this carrier with the
  statically-known name string + arity. **Reserve its type index up-front**
  (alongside the other shared standalone runtime types) so late closure
  registration never shifts it — see `reference_subview_type_idx_stability` /
  `project_type_index_shift_and_deadelim`. User closures and gc mode are
  untouched → gc bytes stable.
  - _Cost:_ the value is no longer the bare funcref-wrapper the call sites expect;
    `call_ref` and callback-dispatch must read `$BuiltinFn.$fn` before the indirect
    call. This is the `filter(Array.isArray)` fix too (see gap 1/callback below).

- **Option B — append fields to the existing builtin-closure wrapper type only**,
  keeping it distinct from the user-closure wrapper. Less new plumbing but the
  wrapper type is produced by the shared `getOrCreateFuncRefWrapperTypes`; you'd
  fork a `…WithMeta` variant. Roughly equivalent; A keeps the carrier explicit.

### Build plan (incremental, each slice independently mergeable + net-positive)

Order chosen so the earliest slice is the smallest verifiable win and de-risks
the carrier shape before the broad reflective work:

1. **Slice 1 — `.length` direct returns true arity.** Carry `$length` on the
   builtin closures; in `dyn-read.ts` replace the flat `box_number(0)` closure
   arm with `struct.get $BuiltinFn $length → f64.convert → box_number`. Smallest
   slice; flips a batch of `length.js` direct-access cases and validates the
   carrier end-to-end. Verify the dyn `.length` chain ordering (closure arm is
   tested **innermost/last**, after the vec arms) is preserved.

2. **Slice 2 — reflective GOPD on function values.** In
   `__getOwnPropertyDescriptor` (object-runtime.ts:5552), **before** the
   `!$Object → undefined` bailout, add: `ref.test $BuiltinFn`; on hit, compare
   the key against native `"name"`/`"length"` and synthesize a DATA descriptor
   via the existing `__create_descriptor(value, flags)` helper
   (object-runtime.ts:5699) with `flags = configurable-only (0x04)` →
   `{value, writable:false, enumerable:false, configurable:true}`. `value` =
   `$name` (already externref) or `box_number(f64($length))`. Any other key →
   fall through to `undefined`. This is the **broad** flip
   (`verifyProperty` reads GOPD): once it lands, `name.js`/`length.js`/
   `prop-desc.js` for every wired function value flip together.

3. **Slice 3 — the rest of the reflective surface `verifyProperty` exercises:**
   - `__extern_get(fn, "name"|"length")` (dynamic `fn[key]` — object-runtime
     `__extern_get`): same `ref.test $BuiltinFn` arm returning the field value
     (this also closes the **host-import leak** on computed-key reads).
   - `__hasOwnProperty(fn, "name"|"length")` → true; other keys per spec (false,
     no proto walk for own-check).
   - `__getOwnPropertyNames(fn)` (object-runtime.ts:5827) → include
     `["length","name"]` in spec order for a `$BuiltinFn`.
   - `isEnumerable`/`isWritable`/`isConfigurable` in propertyHelper derive from
     GOPD, so Slice 2 already covers them.

4. **Slice 4 — callback dispatch + destructive `verifyProperty`.** Ensure
   passing a `$BuiltinFn` value where a callback funcref is expected reads
   `$BuiltinFn.$fn` (fixes `filter(Array.isArray) → 0`). `verifyProperty` is
   _destructive_ (it `delete`s the configurable prop then redefines): name/length
   are `configurable:true`, so `delete fn.name` / `Object.defineProperty(fn,…)`
   on a `$BuiltinFn` must at least not trap. Decide scope: a faithful mutable
   own-property table on function values is a large extension — if too big, gate
   `verifyProperty`'s restore step by making delete/redefine on the synthesized
   name/length **no-op-but-non-throwing** and confirm the corpus still nets
   positive (most `name.js`/`length.js` only read; the destructive arm runs after
   the value/attribute asserts). Measure before committing the mutable path.

### Index / funcidx hazards (read before coding)

- **Reserve the `$BuiltinFn` type index up-front** with the other shared
  standalone runtime types; never let it be allocated by a late closure
  registration (would shift and break `ref.test typeIdx` sites). Type indices are
  rec-group/dead-elim stable only when registered once, early
  (`project_type_index_shift_and_deadelim`).
- The new descriptor/extern-get arms call `__create_descriptor` / `__box_number`
  / native string literals — all already registered defined funcs; resolve their
  funcidx **by name after** `addUnionImportsViaRegistry` / late-import flushes,
  exactly as the surrounding `__getOwnPropertyDescriptor` body does
  (`reference_1461`/`reference_2191`/`reference_2193` — late-import funcidx
  desync class).
- `ref.test`/`ref.cast` on `$BuiltinFn` is funcidx-safe (type-index based) — same
  discipline as the existing vec/closure arms in `dyn-read.ts`.

### Corpus-verify recipe (the authoritative gate)

- Local probe harness used here: `.tmp/mech.mts` / `.tmp/mech2.mts` /
  `.tmp/mech3.mts` (compile `target:"standalone"`, instantiate with `{}`, assert
  `result.imports` has no `env.*` host import) and `.tmp/probe-fnmeta.mts`
  (runs `runTest262File(file,"built-ins",15000,"standalone")` over a deterministic
  sample). Re-run `probe-fnmeta.mts` before/after to show the fail→pass delta on
  the **real** `built-ins/**/{name,length,prop-desc}.js` files (not synthetic).
- **Acceptance is the full `merge_group` standalone report net-positive** + zero
  host-mode (gc) regression. Confirm host-free via empty `result.imports` on the
  controls above. Do **not** refresh any baseline to mask a regression.

### Files

- `src/codegen/property-access.ts` — builtin closure factories (`~644`, `~861`,
  `~954`, `~704`), carry name/length on the carrier.
- `src/codegen/dyn-read.ts` — `~291` closure `.length` arm + `closureBaseWrapperTypeIdxs`.
- `src/codegen/object-runtime.ts` — `__getOwnPropertyDescriptor` (5552),
  `__create_descriptor` (5699), `__getOwnPropertyNames` (5827), `__extern_get`,
  `__hasOwnProperty`; new `$BuiltinFn` type reservation alongside the other
  shared standalone runtime types.
- `src/codegen/closures.ts` — `getOrCreateFuncRefWrapperTypes` (only if Option B).

---

## Implementation (dev-f1, 2026-07-02 — PR)

Shipped a variant of the spec's Option B that avoids BOTH hazards the spec
flagged (no shared-wrapper widening, no early type-index reservation needed):

- **Per-(builtin, member) meta SUBTYPE** (`builtin-fn-meta.ts`
  `ensureBuiltinFnMetaType`): each builtin closure value gets a unique struct
  subtype of its signature wrapper — `{funcref func; (mut i32) bfnstate}`.
  Subtyping keeps every call path untouched (static closure call, reflective
  `.call`, any-typed callback dispatch all cast to the sig wrapper/root).
  `name`/`length` are NOT fields — they are compile-time constants keyed by the
  meta type index (`ctx.builtinFnMetaByTypeIdx`); `bfnstate` is a per-instance
  deleted-bits mask (bit0 name / bit1 length) so `verifyProperty`'s destructive
  `isConfigurable` (`delete fn.name` → `!hasOwnProperty`) genuinely works.
- **Reserve/fill reflective natives** (`object-runtime.ts`):
  `__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
  `__builtinfn_push_ownnames` registered with constant default bodies
  (standalone-gated; gc bytes untouched); `ref.test <metaType>` arms SPLICED at
  finalize by `fillBuiltinFnMeta` (index.ts, next to `fillExternGetIdxVecArms`)
  — same discipline as `fillExternIsArray`, so compile-order can't freeze an
  incomplete type list. Eager arms in `__extern_get`, `__hasOwnProperty` /
  `__object_hasOwn`, `__getOwnPropertyDescriptor`, `__getOwnPropertyNames`,
  `__delete_property` call the reserved helpers (funcIdx baked at registration
  → shift-invariant preserved).
- **dyn-read `.length` closure arm** now consults `__builtinfn_get_meta`
  (standalone) instead of flat `box_number(0)`; null → 0 (matches
  `Function.prototype.length` after delete).
- **Direct-read meta fold generalized**: `BUILTIN_STATIC_METHOD_ARITY` (spec
  arities of every standard builtin static method, host-generated) folds
  `<Builtin>.<staticMethod>.length/.name` — subsumes the wired-closure-only
  path and answers methods whose VALUE-read is not yet wired (the dominant
  corpus shape after the runner's `verifyProperty` transform).

### Test Results (A/B vs branch base d0bfaa7d6, standalone, real runner)

| corpus                                                        | base               | patched            | delta                                                                                                                |
| ------------------------------------------------------------- | ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| mechanism probes (13)                                         | 5 pass             | 12 pass            | +7 (13th is the pre-existing `hasOwnProperty.call` invalid-wasm bug, unchanged — separate issue)                     |
| `built-ins/**/{name,length,prop-desc}.js` sample (184/1836)   | 99 pass / 31 fail  | 109 pass / 21 fail | **+10 flips, 0 regressions** (≈ +100 extrapolated)                                                                   |
| direct-reflective corpus (281 files with gOPD-on-fn reads)    | 53 pass / 225 fail | 66 pass / 212 fail | **+13 flips, 0 regressions** (accessor-getter name tests: `gOPD(RegExp.prototype,"dotAll").get.name` → "get dotAll") |
| `tests/issue-2896.test.ts` (new, 11 tests)                    | —                  | 11 pass            | host-free asserted (zero env imports)                                                                                |
| related suites (2885/2876/2923/2193/2861/2580/2175, 69 tests) | —                  | all pass           | no regression                                                                                                        |

**Honest-scope note (measure-first):** the spec's ≈250–360 "directly
addressable" estimate assumed test262's `propertyHelper.js` runs verbatim; this
repo's runner TRANSFORMS `verifyProperty(obj, k, {value: X})` into a direct
`assert_sameValue(obj[k], X)` read and strips attribute checks
(`tests/test262-runner.ts:1333`). So the reflective descriptor substrate is
exercised by the corpus mainly via dynamic receivers (accessor `.get`
extraction, harness-loop receivers), and the DIRECT-read fold is the bigger
corpus lever today. The substrate is in place for when the runner shim is
retired. The `Object.prototype.hasOwnProperty.call(fn, k)` invalid-wasm CE
(`call[0] expected type externref`) is pre-existing on base and unrelated.
