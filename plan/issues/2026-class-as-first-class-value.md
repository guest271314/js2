---
id: 2026
title: "classes are not first-class values: new K() on a parameter throws 'No dependency provided for extern class', .constructor identity broken"
status: in-progress
assignee: ttraenkler/sdev-async2
sprint: 63
created: 2026-06-10
updated: 2026-06-18
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: core-semantics
related: [1395, 1116, 1721, 1992]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2026 — no runtime constructor-object identity

## Problem

```ts
const C = class { v = 3; m(): number { return this.v * 2; } };
function make(K: any): any { return new K(); }
make(C).m()
// wasm: THROW: No dependency provided for extern class "K"   node: 6
```

Also: `new A().constructor === A` → 0 (node: true); `A instanceof
Function` → false (filed separately as #1992). Direct `new C()` on a class
expression works.

## Root cause

`src/codegen/expressions/new-super.ts:1534` (`compileNewExpression`) — a
constructee that isn't a statically known class falls through to the
extern-class import intent, which `src/runtime.ts:4584` rejects; class
identifiers have no runtime constructor-object representation.

## Fix direction

Give each class a runtime constructor descriptor (struct with class-id +
ctor funcref); `new <dynamic>` dispatches through it when the static path
misses. Same descriptor backs `.constructor` identity and
`new.target === C` (#2023) — consider one architect spec for the family.

## Acceptance criteria

- Repro returns 6; `.constructor === A` true
- Statically-resolved `new` unchanged (no perf regression)

## Dupe check

#1395 (static descriptor, done), #1116b (JS-side ctor bridge, done), #1721
(subclass Function/Object, done). Class-through-variable `new` not filed.
New.

---

## Implementation Plan

> Architect spec, 2026-06-17. Based on `upstream/main` @ `79e16bb37`.
> Anti-dup: no `## Implementation Plan` existed before this; PR #1647 is the
> doc-only routing/validation PR (no spec). No open PR speccs this.

### Root cause (precise)

`compileNewExpression` (`src/codegen/expressions/new-super.ts`, the giant
dispatcher starting ~line 1612) resolves the constructee **statically**: it
needs `className` to land in `ctx.classSet` (line ~3201), `ctx.funcConstructorMap`
(function-style ctor, line ~2899), or `ctx.externClasses` (line ~3317). For

```ts
function make(K: any): any { return new K(); }
```

`K` is a value-bound parameter. The type checker gives `new K` the type `any`,
so `symbol?.name` is undefined and `ctx.classSet.has(K)` is false. Because
`expr.expression` IS an identifier (`K`), the resolution at line ~2801 sets
`className = "K"` only if `"K" ∈ classSet` — it isn't — so `className` stays
`undefined`/`"K"`, the function-ctor and local-class arms miss, and execution
reaches the **extern-class arm** (line ~3317) keyed on the literal name `"K"`.
No `K_new` import exists, so either a compile-time `Missing import for
constructor: K_new` fires, or (when an extern intent was registered) the
runtime resolver at `src/runtime.ts:6230` throws `No dependency provided for
extern class "K"`. Either way: the **value bound to the parameter is never
consulted** — there is no runtime constructor representation to `call_ref`.

The class VALUE that flows into `K` already exists and is correct: a class
identifier as a value resolves to the `__class_<Name>` singleton
(`emitLazyClassObjectGet`, `src/codegen/expressions/extern.ts:258`), an
`extern.convert_any`'d `$ClassName` struct whose `__tag` field carries the
class-id (`ctx.classTagMap`). So the descriptor is **present at the call site
as an externref**; what is missing is a uniform **construct ABI** that, given
that externref, dispatches to the right `<Class>_new` and returns a boxed
instance.

### Design: uniform boxed-instance construct ABI via a per-class ctor trampoline

Add a **uniform constructor entry** for every WasmGC-struct-backed class, of a
single shared signature, reachable by `call_ref` off a funcref keyed by the
class-tag carried on the class-object descriptor. The static `new ClassName()`
path is **left exactly as is** (no perf change, no boxing): only the *dynamic*
`new <value>()` fallback changes.

**Uniform ctor signature** (one func type, registered once):

```wat
(type $UniformCtor (func (param $argv (ref null $ObjVecArr)) (result externref)))
```

- `$argv` = the boxed-externref argument vector (reuse the existing
  `$ObjVecArr` = `(array (mut externref))` from object-runtime.ts, the same
  type Object.keys/values enumeration already uses — do NOT mint a new array
  type, it invites the #2009 canonicalization hazard).
- result = the constructed instance **boxed to externref** (`extern.convert_any`
  on the `(ref $ClassName)` the real ctor returns; externref-backed subclasses
  already return externref so they pass through).

**Per-class trampoline** `__ctor_uniform_<Name>`: a generated function of type
`$UniformCtor` that
1. reads each `<Class>_new` param `i` from `$argv[i]` (null-extern when
   `i >= argv.len`, matching the existing missing-arg padding), coercing the
   boxed externref to the param's ValType via the **existing** unbox helpers
   (`coerceType` externref→f64 uses `__unbox_number`/ToNumber; externref→ref
   uses `any.convert_extern` + `ref.cast`; see type-coercion.ts). For
   `any`-typed params keep externref.
2. `call`s `<Class>_new` (re-resolve idx via `classMemberFuncKey`).
3. boxes the result to externref and returns.

This trampoline is the SAME shape as `emitFuncRefAsClosure`'s trampoline
(`src/codegen/closures.ts:3285`) — model the arg-unpacking loop on that code.

**Descriptor wiring.** The class-object descriptor singleton (the
`__class_<Name>` global, built in `emitLazyClassObjectGet`) gains the ability to
answer "give me your uniform ctor funcref". Two implementation options — pick
**(A)** for the first PR (smaller blast radius), leave (B) as a noted
follow-up:

- **(A) class-tag → funcref table (recommended).** Build one module-level
  `(table $ctorTable funcref)` (or an `(array funcref)` global) indexed by
  class-tag (`ctx.classTagMap` values are dense small ints). At class
  registration, `elem`/`array.set` slot `tag → ref.func $__ctor_uniform_<Name>`.
  The dynamic path reads the tag off the descriptor externref
  (`any.convert_extern` → `ref.cast` the class-object struct → `struct.get`
  the `__tag` field), then `table.get $ctorTable` / `call_ref $UniformCtor`.
  No host import; works standalone.
- **(B) descriptor carries the funcref directly.** Add a `__ctor` funcref field
  to the `$ClassName` class-object struct and `struct.new` it with
  `ref.func $__ctor_uniform_<Name>`. Cleaner but mutates the class struct
  shape used for instances too — higher regression surface
  (`patchStructNewForDynamicField` territory). Defer.

### Changes (sliced into dev-sized PRs)

**PR-1 — uniform ctor trampolines + tag→funcref table (the core).**

*File: `src/codegen/expressions/new-super.ts`*
- New `emitUniformCtorTrampoline(ctx, className): number` — generates
  `__ctor_uniform_<Name>` (type `$UniformCtor`), returns its funcIdx. Call it
  once per WasmGC-struct class, right after the class ctor is registered (near
  `class-bodies.ts:667` where `<Class>_new` is set up — or lazily on first
  dynamic-new use, keyed in a `ctx.uniformCtorFuncIdx: Map<string,number>` to
  avoid emitting for classes never used dynamically).
- New `ensureCtorTable(ctx)` — registers the `$UniformCtor` func type + the
  `(table funcref)` (or `(array funcref)` global) once; idempotent. Populate
  slot `classTag → trampoline funcIdx` when a trampoline is emitted.

*File: `src/codegen/expressions/new-super.ts`, `compileNewExpression`*
- **New fallback arm**, inserted as the LAST resolution attempt — AFTER the
  extern-class arm (line ~3317) and the builtin-ctor arms, immediately BEFORE
  the terminal `reportError(... "Unsupported new expression ...")` at line
  ~3822. Guard: `ts.isIdentifier(expr.expression)` (or `PropertyAccess`/`this`
  per §below) AND the static resolution produced no class/func/extern match AND
  the value's static type is a class-or-`any` (see Edge cases). Emit:
  1. compile `expr.expression` → externref (the class descriptor value).
  2. build `$argv`: `array.new_fixed $ObjVecArr` over the compiled+boxed args
     (each arg `compileExpression(... {externref})`; spread → fall through to
     refusal in PR-1, handle in PR-3).
  3. read the class-tag off the descriptor, `table.get`/`call_ref $UniformCtor`.
  4. result type `{ kind: "externref" }`.
- Keep the existing static `classSet` arm (line ~3201) UNCHANGED — static
  `new C()` keeps emitting the direct typed `call` + `(ref $struct)` result,
  zero boxing, zero perf regression. This is the hard acceptance criterion.

**PR-2 — `.constructor` identity through the descriptor (`new A().constructor === A`).**
- `src/codegen/property-access.ts:3457` already routes `.constructor` on a
  statically-typed instance to the `__class_<Name>` singleton via
  `emitLazyClassObjectGet` — that path already makes `new A().constructor === A`
  hold for the STATIC receiver. Verify the repro's failing case
  (`new A().constructor === A → 0`) is the case where the instance type is
  inferred (e.g. through `make(C)` returning `any`); for an `any`/externref
  receiver `.constructor` can't statically know `typeName`. PR-2 scope: when the
  receiver is externref and carries a boxed class instance, read the instance's
  class-tag (instances already carry `__tag`? confirm — if not, this is the slot
  to add) and map tag→`__class_<Name>` singleton. If instances do NOT carry a
  tag, scope PR-2 to ONLY the statically-typed receiver (already works) and file
  the externref-receiver `.constructor` as a follow-up; do not block PR-1.

**PR-3 — spread / arity / derived-class args in the dynamic path.**
- `new K(...args)` and arg-count mismatches: extend the `$argv` builder to
  flatten spread (reuse `flattenCallArgs`); the trampoline already null-pads
  missing params. Subclass-through-value (`new K()` where `K` is a derived
  class value) works automatically because `<Class>_new` already drives the
  super-chain — just confirm with a test.

### Wasm IR pattern (dynamic-new fallback, option A)

```wat
;; new K(a, b)  where K is a value-bound class descriptor (externref)
;; 1. evaluate descriptor
local.get $K                       ;; externref class-object
;; 2. read class-tag from descriptor  (any.convert_extern + ref.cast class-object struct + struct.get __tag)
any.convert_extern
ref.cast $ClassObjBase             ;; the class-object struct carrying __tag
struct.get $ClassObjBase $__tag    ;; -> i32 classTag
;; 3. build argv = [box(a), box(b)]
<compile a -> externref>
<compile b -> externref>
array.new_fixed $ObjVecArr 2       ;; -> (ref $ObjVecArr)
;; 4. dispatch: ctorTable[classTag](argv) -> externref
local.set $argv
local.get $tag
table.get $ctorTable               ;; -> (ref $UniformCtor)  (or array.get on a funcref array)
local.get $argv
call_ref $UniformCtor              ;; -> externref instance
```

```wat
;; __ctor_uniform_K  (type $UniformCtor): param $argv (ref null $ObjVecArr) -> externref
;; for each K_new param i:  read argv[i] (null-extern when i>=len), coerce to param ValType
local.get $argv  i32.const 0  ... <bounds + array.get + coerce>   ;; arg0
local.get $argv  i32.const 1  ... <coerce>                        ;; arg1
call $K_new                        ;; -> (ref $K)
extern.convert_any                 ;; box instance
;; (externref-backed subclass: K_new already returns externref — skip the box)
```

### Edge cases

- **Static path untouched**: `new C()` on a directly-typed class must still hit
  the `classSet` arm and return `(ref $struct)`, NOT externref. Gate the new
  fallback so it only fires when static resolution genuinely missed — assert via
  a test that `new C()` codegen is unchanged before/after.
- **Non-class value** (`new K()` where `K` holds a number/string/plain object):
  the descriptor has no valid class-tag. The trampoline table lookup must
  trap-clean into a TypeError, not an illegal `call_ref`. Reserve tag 0 / a
  null table slot → emit `throw TypeError("K is not a constructor")`. Use the
  existing `emitThrowTypeError` path. (test262
  `language/expressions/new/non-ctor*` patterns.)
- **`null`/`undefined` descriptor**: `new K()` with `K == null` → TypeError, not
  null-deref. Guard with `ref.is_null` before the tag read.
- **new.target (#2023)**: the dynamic path should set new.target to the resolved
  class id inside the trampoline (mirror `emitSetNewTargetBeforeCall`), so
  `new.target === K` inside the body holds. Defer to a follow-up if it
  complicates PR-1; note it.
- **externref-backed subclasses** (`extends Error/Map/...`, `classBuiltinParentMap`):
  these have no `$ClassName` struct and no class-object singleton, so they are
  NOT registered in the ctor table — a dynamic `new K()` on such a value keeps
  the current behaviour (out of scope; document).
- **`new this(...)` in a static method (#1679)** already has a path
  (line ~2831); leave it — the new fallback must run only after it misses.

### Files to touch (summary)
- `src/codegen/expressions/new-super.ts` — trampoline emit, ctor-table ensure,
  dynamic-new fallback arm.
- `src/codegen/class-bodies.ts` (~line 664) — emit/slot the uniform trampoline
  when the class-object global is registered (or lazily; see PR-1).
- `src/codegen/expressions/extern.ts` (`emitLazyClassObjectGet`, ~line 258) —
  ensure the class-object struct exposes the `__tag` for the dynamic tag read
  (it already carries `__tag`; confirm field index).
- `src/codegen/property-access.ts` (~line 3457) — PR-2 only.

### Implementation log (sdev-async2, 2026-06-17)

Re-validated repro on `upstream/main` @ `fe0e21ba1`: `THROW: No dependency
provided for extern class "K"` — confirmed. Traced the live path precisely:

- `new K()` (K an `any` param) reaches `compileNewExpression`'s **`!className`
  unknown-ctor branch** (`new-super.ts:2954`), NOT the terminal `reportError`
  at 3812. `ctorName = "K"`. It falls past the `resolvesToNonConstructableValue`
  guard (2992, doesn't fire for K) and the ArrayBuffer/DataView/Array builtin
  arms, then emits the `__new_K` unknown-ctor import (~3168) → runtime
  `runtime.ts:6230` throws "No dependency provided for extern class K".
- Insertion point for the dynamic fallback: **inside the `!className` branch,
  immediately before the `__new_${ctorName}` import emission (~3168)**, gated on
  `ts.isIdentifier(s1Callee)` + value-type is class-or-`any`. Try the ctor-table
  dispatch first; on a null/invalid tag, **fall through to the existing
  `__new_` import** so `Test262Error`-style genuine host builtins keep working.
- Tag read: class root structs get `__tag` at **field 0** (`class-bodies.ts:598`),
  child classes inherit it. Class-object descriptor reuses the **same
  `$ClassName` struct** as instances (`extern.ts:317`), so the value in `K` is an
  `extern.convert_any`'d `$ClassName` struct carrying `__tag`. To read it
  generically I register one shared open base `$ClassTagBase =
  (sub (struct (field $__tag i32) (field $__shape_brand i32)))` and set it as the
  superTypeIdx of every class-ROOT struct (`class-bodies.ts:632`); the existing
  `__shape_brand` sentinel (626) already dodges the #2009 `$AnyString`
  canonical-merge. Then `any.convert_extern` + `ref.test $ClassTagBase` +
  `struct.get 0` yields the tag with no host import (standalone-safe).
- `$ObjVecArr` = `(array (mut externref))` (`object-runtime.ts:273`) is the argv
  array type — reuse it, do not mint a new one.
- `<Class>_new` is keyed `classMemberFuncKey(ctx, "${className}_new")`
  (`class-bodies.ts:736`); the uniform trampoline re-resolves it per class.

### Slice plan (PR-1 → PR-3)

- **PR-1 (core) — DONE (host mode).** Implemented as a tag-dispatch chain in
  `emitDynamicNewFallback` (`new-super.ts`), NOT the `$ClassTagBase` supertype
  + `(table funcref)` from the original sketch. Rationale discovered during
  implementation: `ref.test $Class` cannot distinguish structurally-identical
  classes (WasmGC iso-recursive canonicalization merges two `{x:number}`
  classes; a `ref.test` matches both — verified, it mis-constructed B for A).
  So discrimination MUST be by the `__tag` value, not the struct type. The
  shipped design avoids any struct-hierarchy change (lower regression surface
  than a shared base supertype): read `__tag` (field 0) via a
  `ref.test`/`ref.cast` against any shape-compatible candidate struct (valid
  under canonicalization), then a flat `tag == classTag` if/else chain selects
  `<Class>_new`, threading boxed args coerced to each ctor param's ValType. No
  host import → pure-Wasm. No-match base falls through to the legacy `__new_`
  host import (host mode) so genuine builtins (Test262Error) keep working;
  gated off in `noJsHost` mode. Static `new C()` path UNCHANGED (the
  `classSet` arm is never touched). Repro → 6. Tests: `tests/issue-2026-dynamic-new.test.ts`
  (6 cases incl. shape-collision dispatch, arg threading, static regression
  guard, builtin fallthrough). tsc + biome clean; stack-balance gate OK.
  **Standalone (`--target wasi`) deferred:** `new K()` already failed on main
  in standalone (the unused `__new_K` import trips the WASI allowlist at
  module-build, independent of dispatch). Fixing it needs suppressing that
  import registration in `collectUnknownConstructorImports` for value-bound
  class identifiers — split out to avoid PR-1 regression risk (PR-1b).
- **PR-1b — DONE (standalone/WASI parity).** Two no-JS-host gaps, not one:
  1. **`__new_<name>` host-import registration** (`collectUnknownConstructorImports`
     finalize, `declarations.ts:1436`). For `new K()` on a value-bound class
     identifier it registered `env.__new_K`, which the strict-import allowlist
     gate (`addImport`, #1524) rejected *at registration time* — a single
     `new K()` failed the whole standalone compile (`Host import "env.__new_K"
     … not on the dual-mode allowlist`). Fix: in no-JS-host mode (`ctx.wasi ||
     ctx.standalone`), after the WASI-error-name native path, **skip the host
     import entirely** — it is never satisfiable with no host, and the pure-Wasm
     `emitDynamicNewFallback` (PR-1) is the resolution path (it reads the
     class-object `__tag` and tag-dispatches to `<Class>_new`; its no-match base
     already yields a null externref in no-JS-host mode). Host (JS) mode
     unchanged.
  2. **`__register_class_object` registered under `--target wasi`** — the
     deeper, latent blocker. The skip guard (`index.ts:1121`) excluded only
     `ctx.standalone`, so **`wasi` still registered** the JS-host Proxy own-key
     notification import. `emitLazyClassObjectGet` (`extern.ts:269`) then took
     its CSV-notify branch and `global.get`'d the static-methods-CSV **string**
     global, which under nativeStrings is **not a real module global** — baking
     a `-1` global index that crashed binary emit (`global index out of range —
     -1`) the *instant a class flowed as a value* (`use(A)`, `const v:any=A`,
     hence `new K()`). Reproduced on **unmodified upstream/main** under
     `--target wasi`, and did NOT under `--target standalone` (which already
     skipped the import) — so it pre-dates #2026 and is a general
     class-as-value bug, surfaced here because the dynamic-new ABI requires the
     class descriptor to flow as an externref. Fix: extend the skip to **both**
     no-JS-host targets — `!(ctx.standalone || ctx.wasi)`. The import is a
     JS-host Proxy notification with zero effect on actual class / method /
     static-field behavior (verified: instance methods, static methods, static
     fields all correct in wasi+standalone after removal).

  Result: `new K()` through an `any` param returns the correct instance in
  `--target wasi`/`standalone` with **zero `env` host imports**; arg threading
  and shape-collision tag dispatch correct; static `new C()` untouched. Tests:
  `tests/issue-2026-standalone-dynamic-new.test.ts` (6 cases, all assert no
  `env` imports + instantiate with `{}`). PR-1 host test
  (`issue-2026-dynamic-new.test.ts`, 7) still green. Files: `declarations.ts`,
  `index.ts`. Branch `issue-2026-standalone-ctor-abi`.
- **PR-2:** `.constructor === A` for the externref/`any`-typed receiver via the
  same tag→`__class_<Name>` map (statically-typed receiver already works).
- **PR-3:** spread/arity/derived-class args in the dynamic path (reuse
  `flattenCallArgs`); new.target threading; non-constructor / null descriptor
  TypeError edge cases.

### Test files to verify
- New `tests/issue-2026.test.ts`:
  - `function make(K:any){return new K()}; const C=class{v=3;m(){return this.v*2}}; make(C).m()` → 6
  - `new A().constructor === A` → true (PR-2)
  - `new K(1,2)` arg threading (PR-3)
  - non-constructor value `new (42 as any)()` → throws TypeError
  - `new (null as any)()` → throws TypeError (no null-deref)
  - regression guard: `new C()` direct still returns a typed instance (no
    externref widening) and its method calls keep working.
- Host + standalone (`--target wasi` / nativeStrings) for each — the ABI is
  pure-Wasm (no host import) so both modes must pass.
- Confirm no test262 `built-ins/`/`language/` regressions in the
  classes/new buckets (CI).

### Implementation plan — #53: variable-spread runtime argv (sdev-ctor, 2026-06-18)

PR-3a (#1699) made array-literal spread work via `flattenCallArgs` and turned a
**non-flattenable** spread (`new K(...someVar)`) into a loud compile-time
`reportError` (because the legacy `__new_` fallthrough trips the #2043/#51
binary-emit crash in standalone). #53 makes that case actually WORK and removes
the refuse.

**Root cause it solves.** `emitDynamicNewFallback` pre-evaluates a
COMPILE-TIME-fixed set of `argLocals` (one per positional arg) and each tag-arm
reads `argLocals[i]`. A `...someVar` spread has a RUNTIME length, so there's no
fixed arg count — `compileSpreadCallArgs` can't help (it targets one
statically-known funcIdx, not a multi-tag runtime dispatch).

**Design — runtime `$ObjVecArr` argv (reuses PR-1's tag dispatch; no funcref
table).** When `args` contains a non-flattenable spread, instead of fixed
`argLocals` build a runtime argv:
1. Compile a running **`argv` `(ref $ObjVecArr)`** + an `argc` i32. `$ObjVecArr`
   = `(array (mut externref))` (object-runtime.ts:273) — reuse, do NOT mint
   (the #2009 canonicalization hazard). Size argv to an upper bound (sum of
   non-spread args + each spread source's runtime `len`), or grow incrementally.
2. For each plain positional arg: `compileExpression → externref → array.set
   argv[k++]`.
3. For each spread: `compileExpression(spread.expression)` → vec struct
   `{len, data}` (the existing array-value representation, see
   `compileSpreadCallArgs` extern.ts:519-540 for the extract pattern); loop
   `for j in 0..len: argv[k++] = box(data[j])`. Box each element to externref
   via `coerceType`.
4. Each tag-arm (`buildCtorArm`) reads `argv[i]` with a RUNTIME bounds check:
   `i < argc ? (array.get $ObjVecArr argv i) : ref.null.extern`, then coerces to
   the ctor param ValType (the existing externref→ValType coerce). This swaps
   the compile-time `i < argLocals.length` for a runtime `i < argc` — the only
   change to the arm; the tag dispatch, no-match base, and box-result logic are
   untouched.

**Why not the funcref-table `$UniformCtor` trampoline (architect option A):**
the runtime-argv extension above reuses PR-1's proven flat tag-chain with the
SAME blast radius as PR-3a (one function, additive), avoiding a new module-level
table/elem segment + funcref type (more surface, the late-import-shift hazard
class). The trampoline-table is the right move only if we later need `call_ref`
dispatch off a first-class ctor value (e.g. `Reflect.construct(K, argv)` /
storing ctors) — file that as a separate follow-up if it arrives.

**Edge cases:** spread of an empty array → argc 0 → all params null-padded;
mixed `new K(a, ...rest, b)` (trailing positional after spread) → argv built in
source order so indices stay correct; spread source not an array (a non-iterable)
→ keep a loud refuse for now (true iterator-protocol drive is #42 territory).
Floor-gate HW; helpers by name; box-result reuses PR-3a's `getFuncResultType`
externref-skip guard. Standalone + host both pure-Wasm.

Builds on #1699 (merge it into the #53 branch first so this REPLACES the
loud-refuse, not the raw crash). Branch `issue-2026-dynnew-argv`.

### Progress + BLOCKER (sdev-ctor, 2026-06-18)

Implemented the full runtime-argv codegen in `emitDynamicNewFallback`
(`new-super.ts`, WIP committed): non-flattenable spread → build a runtime
`$ObjVecArr` argv + `argc` (capacity = #non-spread + Σ spread-source-len;
per-spread copy via a structured `block`/`loop`/`br_if depth 1`), and each
`buildCtorArm` reads `argv[i]` with a runtime `i<argc ? array.get :
pushDefaultValue` (`if` blockType `val pType`). tsc + lint clean.

**BLOCKER — `$ObjVecArr` type-init ordering (#2043 /
[[reference_subview_type_idx_stability]]).** All three repros fail at
binary-emit: `heap type index out of range — -1 at TYPE DEFINITION #15`. Note it
is a **type definition**, not an instruction — so `$ObjVecArr` (or a type
`ensureObjectRuntime` co-registers) is *defined* with an unresolved heap-type
ref of `-1`. Moving `ensureObjectRuntime(ctx)` to the very top of
`emitDynamicNewFallback` (before any instruction is emitted) did NOT fix it —
because the failure is in the TYPE REGISTRATION's own ordering: when
`ensureObjectRuntime` runs from inside expression compilation, the string/`$ObjVec`
types it depends on aren't in the deterministic up-front order, so the
`$ObjVecArr`/`$ObjVec` definition bakes a `-1` element/field heap-type.

Confirmed conclusion: `ensureObjectRuntime` (or at least the `$ObjVecArr` type)
**must be materialized in the up-front type-init phase** (`index.ts:~1042-1055`,
beside `reserveTypedArraySubviewTypes`), NOT lazily. This is exactly the
`reference_subview_type_idx_stability` lesson.

**Resolution (architect-ish call needed):**
- **(A)** call `ensureObjectRuntime(ctx)` up-front gated on
  `sourceContainsClass(ast.sourceFile)` — simplest, but it pulls helpers/imports
  for EVERY class-bearing program → must verify no HW-floor / classes-new
  test262 regression from the index shift.
- **(B)** a dedicated tiny `reserveObjVecArrType` up-front (mirror
  `reserveTypedArraySubviewTypes`) that registers ONLY the
  `(array (mut externref))` type, and have `ensureObjectRuntime` adopt the
  pre-reserved idx. Smallest blast radius; preferred — needs
  `ensureObjectRuntime` to accept a pre-reserved type idx.

WIP committed on `issue-2026-dynnew-argv`. Resume: implement (B) up-front in
index.ts (or escalate the A/B choice). The runtime-argv codegen itself is done
and tsc/lint-clean — only the type-init ordering remains.

### RESOLVED — option (B) implemented (sdev-ctor, 2026-06-18)

Implemented (B): `reserveObjVecArrType(ctx)` (`index.ts`) registers ONLY the
`(array (mut externref))` `$ObjVecArr` type up-front in the type-init phase,
gated on `sourceContainsClass(ast.sourceFile)`, storing
`ctx.reservedObjVecArrTypeIdx`. `ensureObjectRuntime` ADOPTS the reserved slot
when present (else registers as before). `emitDynamicNewFallback` uses
`ctx.reservedObjVecArrTypeIdx` directly (no lazy `ensureObjectRuntime`) and bails
loudly if it's somehow absent. Zero new helpers/imports, one self-contained array
type, class-gated → no index shift for class-free programs.

Result (HOST mode): `new K(...someVar)` → correct value (4,5→9; mixed
1,...[2,3]→6; arity-short; shape-collision tag-dispatch; method calls all work).
All 13 existing #2026 tests green; array-literal spread + plain-args unchanged.
tsc + prettier + biome clean. Tests:
`tests/issue-2026-dynamic-new-varspread.test.ts` (6).

**Caveat — standalone *running* dynamic-new is a SEPARATE pre-existing gap (out
of #53 scope).** A standalone/wasi program that RUNS (reads a field off) a
dynamically-constructed instance hits `global index out of range — -1` — and
this reproduces with **plain `new K(7)` (no spread at all)** on this base, so it
is NOT introduced by #53. It is the #51/#1888-family string-global sentinel that
fires when a class flows as a value and its instance is *consumed* in standalone.
PR-1b's standalone tests only assert *compiles* (no-arg, `{}`-instantiate), so
they don't exercise it. #53 fixes the variable-spread argv (host); the standalone
*running* sentinel is a distinct follow-up (relate to #51).

Edge note: missing-arg padding uses `pushDefaultValue` (f64 → 0), so a ctor that
distinguishes a *missing* arg via `b ?? 99` sees 0, not undefined. True
`undefined`-padding for `??`/default-param semantics is a narrow refinement —
noted.
