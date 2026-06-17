---
id: 2026
title: "classes are not first-class values: new K() on a parameter throws 'No dependency provided for extern class', .constructor identity broken"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
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
