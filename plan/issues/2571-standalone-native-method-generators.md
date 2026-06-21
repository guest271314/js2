---
id: 2571
title: "standalone: class/object-literal method generators leak env.__gen_* host imports — no native lowering (validate-but-can't-instantiate)"
status: done
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: sd-2
residual: "object-literal method generators ({ *m(){} }) keep the host path — deferred follow-up (closures.ts lifted-closure path needs native wiring); class/static/instance method generators are native."
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: generators, classes, object-literals
goal: standalone-mode
related: [2040, 1665, 2170, 2171, 2203, 680, 1983]
test262_bucket: standalone-method-generator-hostimport-leak
test262_count: 250
es_edition: es2015
spec_status: ready
spec_author: sd-5
spec_date: 2026-06-21
spec_note: "Implementation Plan written (sd-5). Key insight: `this` is just a leading param — the native state machine already persists+rehydrates params, so threading `this` as a synthetic leading param + admitting MethodDeclaration in the candidate gate + routing the class/object-literal emit through the existing factory does it; the .next()/.return()/.throw() dispatch is already representation-agnostic. A+B+C land as one PR. Broad blast radius (standalone-only) → full gen-method sweep before enqueue."
origin: "Carved from #2040 (sd-5 reproduction, 2026-06-21). Distinct from #2040's cluster-A rest-identity codegen bug (sd-3): this is a separate instantiation bug — class/object-literal METHOD generators have no native lowering, so in a no-JS-host target they emit env.__gen_* imports that validate but cannot be satisfied at instantiate time. Affects ~250/500 generator/class files sampled."
---

# #2571 — standalone native method generators (no host-import buffer path)

## Problem

In a no-JS-host target (`target: "standalone"` / `wasi`), a **class or
object-literal generator method** compiles to a module that **validates** but
**cannot instantiate**:

```ts
class C {
  *m() {
    yield 42;
  }
}
export function run(): number {
  return new C().m().next().value === 42 ? 1 : 0;
}
```

```
WebAssembly.instantiate(): Import #0 "env": module is not an object or function
```

The module imports `env.__gen_create_buffer`, `env.__create_generator`,
`env.__gen_next`, `env.__gen_result_value_f64`, `env.__get_caught_exception`
— the legacy **eager-buffer** generator runtime, which has no standalone
(pure-Wasm) backing.

A free-function generator (`function* g(){ yield 42 }`) does NOT leak — it is
lowered by the **native generator state machine** (#1665/#2170/#2171, in
`src/codegen/generators-native.ts`), which emits zero imports.

This is **distinct from** #2040's cluster-A rest-array-identity bug (the
untyped/externref method-param rest path aliasing the source vec, owned by
sd-3). That one is a value-correctness codegen bug; this one is an
instantiation-time host-import leak. Both surface on `gen-meth-*` files, but
the fixes live in different code (rest-identity → `destructuring-params.ts`;
this → `generators-native.ts` candidate gate + `class-bodies.ts` emit).

## Measured impact

Leak probe over 500 `language/{statements,expressions}/{generators,class}`
files compiled with `target: "standalone"`: **~250 (≈50%) import `env.__gen_*`**
and therefore cannot instantiate standalone. All are `gen-meth-*` (class /
method generators). Estimate ~250+ test262 rows are pass-on-host but
unrunnable-on-standalone purely from this leak.

## Root cause

- `sourceNeedsGeneratorHostImports()` (`src/codegen/generators-native.ts:911`)
  routes **every** `MethodDeclaration` with an asterisk to the host-import
  buffer path unconditionally (`needsHost = true`).
- `isNativeGeneratorCandidate()` (`:795`) only accepts `ts.FunctionDeclaration`
  (requires `decl.name`), and has **no `this` / receiver handling** — class
  method generators (instance vs static, with `this`, possibly capturing the
  class lexical scope) are out of its model.
- The class-method generator emit in `src/codegen/class-bodies.ts:2025-2080`
  unconditionally calls `__gen_create_buffer` / `__create_generator`
  (`ctx.funcMap.get("__gen_create_buffer")!`) regardless of target.

## Why this is hard (not a point fix)

1. **Receiver/`this`** — the native state struct (`generators-native.ts`) has
   no slot for `this` or for captured class-scope bindings. The same gap that
   makes capturing _nested_ generators fall to the host path (#2203) applies to
   method generators, which always have an implicit `this` capture.
2. **Static vs instance** — instance methods carry a `this` param at index 0
   (see `class-bodies.ts` `isStatic` handling); static methods don't.
3. **Laziness** — the buffer model is **eager** (runs the whole body at
   creation, buffers all yields). A mere "buffer into a WasmGC vec instead of a
   host JS array" port would fix _instantiation_ but still fail the spec
   laziness rows (`assert.sameValue(executed, false)` until first `.next()`) —
   roughly the cluster-B "~140 must-be-lazy" rows #2040 flagged. The correct
   fix is the **lazy native state machine** extended to a method receiver, not a
   vec-buffer.

## Suggested approach (architect, then senior-dev)

1. Extend `buildNativeGeneratorPlan` / the native state struct to carry a
   `this` field (and any captured class-scope bindings — reuse / generalize the
   #2203 capture model).
2. Make `isNativeGeneratorCandidate` accept `ts.MethodDeclaration` (asterisk,
   non-async), modelling the receiver param (instance: param 0 = `this`;
   static: none).
3. Route `class-bodies.ts:2025` method-generator emit through
   `compileNativeGeneratorFunction` when `noJsHostTarget(ctx) && candidate`,
   keeping the host-buffer path only for the JS-host target.
4. Update `sourceNeedsGeneratorHostImports` to NOT force `needsHost` for a
   method generator that the (extended) native path can handle.

## Implementation Plan

### Root cause

The native generator state machine (`src/codegen/generators-native.ts`,
#1665/#2170/#2171) is wired only for **named `function*` declarations**:
`isNativeGeneratorCandidate` (:795) requires `decl.name` and is typed
`ts.FunctionDeclaration`; `sourceNeedsGeneratorHostImports` (:911) routes
**every** `MethodDeclaration` with an asterisk straight to the eager-buffer
host path. So class / object-literal method generators always emit
`env.__gen_*` and can't instantiate standalone.

### Key enabling insight — `this` is just a leading parameter

The native machinery **already** persists parameters in the state struct and
rehydrates them as named locals in the resume function:

- The state struct (`registerNativeGenerator` :986-998) appends one immutable
  `param_<name>` field per parameter after the 4-word header
  `[state, sent, mode, abrupt]` (`PARAM_FIELD_OFFSET = 4`).
- The factory (`compileNativeGeneratorFunction` :1646-1648) reads each wasm
  param (`local.get i`) into its struct slot.
- The resume function (:1594-1600) copies each `param_<name>` field back into a
  **local named `info.paramNames[i]`**.
- A `this`-reference compiles via `fctx.localMap.get("this")`
  (`expressions.ts:856-857`).

Therefore, if `this` is modelled as a synthetic **leading param named `"this"`**
(receiver ref type) for an instance method, every `this.field` read inside the
generator body resolves automatically — **no new state-struct field kind, no
new `this`-plumbing**. Static methods have no receiver, so no synthetic param.

The `.next()` / `.return()` / `.throw()` dispatch
(`compileDirectNativeGeneratorMethod` :1702) operates purely on the state
struct and is **already representation-agnostic** — it needs **no change**.
The entire gap is on the **factory (object-construction) side**.

### Work Item A: admit method generators in the candidate gate (~15 lines)

**Patterns addressed**: all `gen-meth-*` (class instance/static, object-literal method).
**Risk**: Low — additive; gated on `noJsHostTarget`, so JS-host mode is byte-identical.
**Priority**: 1st (prerequisite for B/C).

#### Changes

**File: `src/codegen/generators-native.ts`**

- `isNativeGeneratorCandidate` (:795) — widen the param type from
  `ts.FunctionDeclaration` to `ts.FunctionDeclaration | ts.MethodDeclaration`.
  Drop the `!decl.name` rejection for the method case (a method always has a
  name; an anonymous object-literal method via computed/string name is out of
  scope — bail when `decl.name` is a `ComputedPropertyName`). Keep the existing
  async / rest-param / non-identifier-param / declare rejections (note: a method
  body that references `arguments` should bail for now — see Edge cases).
- `generatorElemValType` / `statementContainsYield` / `statementContainsReturn`
  already stop recursion at `ts.isMethodDeclaration` (:150, :191) so a nested
  inner method's yields don't leak into the outer plan — unchanged.

### Work Item B: thread `this` as a leading param in the state model (~25 lines)

**Patterns addressed**: instance method generators that read `this`.
**Risk**: Medium — touches the param-field layout; static methods and free
functions must stay byte-identical (no synthetic param prepended for them).
**Priority**: 2nd.

#### Changes

**File: `src/codegen/generators-native.ts`**

- `registerNativeGenerator` (:958) — when `decl` is a **non-static instance**
  `MethodDeclaration`, prepend a synthetic entry to the param model BEFORE the
  existing `param_*` loop (:992): `paramNames = ["this", ...userParamNames]`,
  `paramTypes = [receiverType, ...userParamTypes]`. The receiver `ValType` is
  the enclosing class's struct ref (the caller already computes it —
  `class-bodies.ts` `params[0].type` for instance methods); pass it into
  `registerNativeGenerator` (extend its `paramTypes` arg, OR add a
  `receiverType?: ValType` param). The existing field loop then mints
  `param_this` as field `PARAM_FIELD_OFFSET + 0` automatically, and the resume
  function (:1594) rehydrates a `this` local automatically.
- `compileNativeGeneratorFunction` (the factory, :1646) — the `local.get i`
  loop must cover the synthetic `this`. For an instance method the wasm param 0
  IS `this` and user params are 1..n (matches `class-bodies.ts` `isStatic ? pi
: pi+1`), so iterate `local.get 0..paramTypes.length-1` UNCHANGED — it already
  reads param 0 first. Verify the factory's param count equals
  `info.paramTypes.length` (now includes `this`).
- Static method: NO synthetic param. wasm params are 0..n-1 (no `this`); the
  free-function code path already handles this shape verbatim.

#### Edge cases

- **Captured class lexical scope** (a generator method closing over a binding
  from an enclosing function, not `this`/fields) — `generatorCapturesOuterScope`
  (#2203, :825) already detects this and forces the host path. Keep that guard:
  a capturing method generator still bails to host (documented follow-up), so
  Work Item B covers only `this` + own-params, not arbitrary closure capture.
- **`arguments` in a method generator** — the eager-buffer path builds an
  `arguments` vec (`class-bodies.ts:2041`); the native resume function has no
  such setup. Bail to host when `bodyUsesArguments(member.body)` (cheap check
  the class emit already computes) until a follow-up.
- **`super.*` in a method generator** — out of scope; bail (rare in `gen-meth-*`).

### Work Item C: route the class/object-literal emit through the factory (~20 lines)

**Patterns addressed**: makes `new C().m()` / `obj.m()` return the native state struct.
**Risk**: Medium — the dispatch site; must preserve the host path for JS-host.
**Priority**: 3rd.

#### Changes

**File: `src/codegen/class-bodies.ts`**

- The generator-method emit (:2048-2080) currently unconditionally builds the
  eager buffer. Add a guard at the top: when
  `noJsHostTarget(ctx) && isNativeGeneratorCandidate(ctx, member) && !isAsyncMethod`,
  register via `registerNativeGenerator(ctx, member, <methodFuncKey>,
paramTypesIncludingThis)` and emit the method body via
  `compileNativeGeneratorFunction(ctx, fctx, member, info)` (returns the state
  struct `ref`), then `return` (skip the buffer block). The method's wasm result
  type becomes `(ref $GenState_*)` instead of `externref` — mirror the
  free-function return-type selection already done at
  `declarations.ts:2493-2494` / `:2984-2985`
  (`results = nativeGenerator ? [{kind:"ref", typeIdx: stateTypeIdx}] : [{kind:"externref"}]`).
  Apply the SAME ternary to the method's signature where the class method's
  result `ValType` is decided.
- **Object-literal method generators** (`obj = { *m(){…} }`) — the analogous
  emit lives in `closures.ts` (object-literal method lowering). Apply the same
  guard there. (If the object-literal method path shares a helper with
  `class-bodies.ts`, gate once; otherwise mirror.)

**File: `src/codegen/generators-native.ts`**

- `sourceNeedsGeneratorHostImports` (:911) — replace the unconditional
  `if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) { needsHost = true }`
  with: `needsHost = true` ONLY when the method is **not** a native candidate
  (`!isNativeGeneratorCandidate(ctx, node)`) **or** it captures outer scope
  (`generatorCapturesOuterScope(ctx, node)`) **or** uses `arguments`. A
  native-capable method generator no longer forces the host imports — exactly
  the free-function-declaration branch's logic (:903), generalized to methods.

#### Dispatch — `new C().m().next()`

No change. `new C().m()` produces the state struct (Work Item C); the
`.next()` / `.return()` / `.throw()` call resolves through
`compileDirectNativeGeneratorMethod` (:1702), which already reads/writes the
state struct generically. The receiver-type check there
(`receiverType.kind === "ref_null"` → `ref.as_non_null`, :1712) already handles
the state ref.

### Implementer notes (exports / call-graph)

- `isNativeGeneratorCandidate`, `registerNativeGenerator`,
  `compileNativeGeneratorFunction` are already **exported** from
  `generators-native.ts` — callable from `class-bodies.ts` / `closures.ts`.
- `noJsHostTarget` is **module-private** (:109). Either export it, or use the
  inline `ctx.standalone || ctx.wasi` (class-bodies.ts already uses that form).
- `registerNativeGenerator(ctx, decl, functionName, paramTypes)` takes a
  `functionName` (used to mint `__GenState_<name>` + the resume func key and to
  cache in `ctx.nativeGenerators`). For a method use a **collision-free** key —
  reuse `classMemberFuncKey` (class-bodies already imports it, #1983) so two
  classes with a `*m()` don't clash. For the synthetic `this` param, the
  simplest signature change is to have `registerNativeGenerator` prepend `"this"`
  - the receiver type when `ts.isMethodDeclaration(decl) && !isStatic`; pass
    `isStatic` + `receiverType` through (or pre-build the `paramTypes`/param-name
    arrays at the call site and pass them in, keeping `registerNativeGenerator`'s
    signature stable — preferred, fewer touch points).

### Sequencing & risk control

- Land **A+B+C as one PR** (they're interdependent: the candidate gate, the
  `this`-param model, and the emit/return-type all must move together or the
  method emits a `(ref $GenState)` the dispatch can't see / leaks imports).
- Keep every guard gated on `noJsHostTarget(ctx)` so **JS-host mode is
  byte-identical** (the eager-buffer path is untouched there).
- This is broad-blast-radius (every method generator changes lowering in
  standalone) → after the narrow fix, run the **full** gen-method test262
  cluster + a BROAD standalone sweep + `check-test262-hard-errors.mjs`; confirm
  net ≥ 0, no new `wasm_compile`, 0 regressions BEFORE enqueue (heed the
  #1837/#1844/#1838 scoped-sweep-miss lesson). Verify free-function and static
  method generators stay byte-identical (no synthetic `this` param leaks in).

### Tests

- `class C { *m() { yield 42; } }` + `new C().m().next().value === 42` —
  standalone: **zero `env.__gen_*` imports**, validates + instantiates + runs.
- Instance method reading `this`: `class C { x = 7; *m() { yield this.x; } }` →
  first `.next().value === 7`.
- Static: `class C { static *m() { yield 1; yield 2; } }` → `1` then `2`.
- Object-literal: `const o = { *m() { yield 9; } }; o.m().next().value === 9`.
- Laziness: `let ran = 0; class C { *m() { ran = 1; yield 1; } }` — `const it =
new C().m();` leaves `ran === 0` until the first `it.next()`.
- test262: `language/statements/class/gen-method-*` and
  `language/expressions/object/gen-meth-*` rows flip from host-import-leak
  (validate-can't-instantiate) to pass standalone.
- Negative / still-host (must keep working, not crash): capturing method
  generator, `arguments`-using method generator, async-gen method — all bail to
  the host path under JS-host and refuse-cleanly (not invalid Wasm) under
  standalone.

## Acceptance criteria

- `class C { *m(){ yield 42 } }` + `new C().m().next().value` compiles to a
  standalone module with **zero `env.__gen_*` imports** and instantiates +
  runs correctly (`WebAssembly.validate` true, `run()` === 42-derived).
- Object-literal method generator `({ *m(){ yield 42 } })` same.
- Static method generator `class C { static *m(){…} }` same.
- Lazy: a method-generator body does not run until the first `.next()`
  (`executed === false` before first next).
- The standalone `env.__gen_*` leak count over the gen-method test262 subset
  drops to ~0; host mode unchanged (no regression).
- No new host imports introduced for the standalone path.

## Resolution (2026-06-21, sd-2) — CLASS method generators native; object-literal deferred

Implemented Work Items A+B+C from the sd-5 spec for **class** (instance +
static) generator methods. Object-literal method generators (`{ *m(){} }`) are
deferred to a follow-up — they lower through the `closures.ts` lifted-closure
path, which is not yet wired to the native state machine; they keep the host
path cleanly (valid module, host imports) — NO regression.

### Changes

- **`src/codegen/generators-native.ts`**
  - `isNativeGeneratorCandidate` widened to `GeneratorDecl =
    FunctionDeclaration | MethodDeclaration` (the single source of truth). For a
    method it bails (→ host) when: computed/string name, NOT a class method
    (object-literal deferred), reads `arguments`, uses `super.*`, or CAPTURES an
    enclosing binding (#2203 — the native state struct has no capture slot).
  - `registerNativeGenerator` gains a `synthesizedThis` flag: when set (instance
    method) it prepends `"this"` to `paramNames`, aligned with the caller's
    `paramTypes = [receiverType, ...userParams]`, so the state struct mints a
    `param_this` field that the resume function rehydrates as a `this` local —
    `this.x` reads resolve via the existing `localMap.get("this")`.
  - `compileNativeGeneratorFunction` factory reads `info.paramTypes.length`
    wasm params (NOT `decl.parameters.length`) so the synthetic `this` (wasm
    param 0) is read into `param_this`.
  - `sourceNeedsGeneratorHostImports` no longer force-routes a native-capable
    class method generator to the host path.
- **`src/codegen/class-bodies.ts`** — the collection pass registers the native
  generator (under `classMemberFuncKey`, `synthesizedThis = !isStatic`) when
  `(standalone||wasi) && !async && candidate`, and sets the method's wasm result
  type to the `$GenState_*` struct ref (mirrors `declarations.ts:2499`). The
  fctx returnType + the emit block route through `compileNativeGeneratorFunction`
  for the native case; the eager-buffer host block is the `else`.
- **`src/codegen/context/types.ts`** — `NativeGeneratorInfo.decl` widened;
  added `synthesizedThis?`.

All guards are `standalone||wasi`-gated → **JS-host (gc) mode byte-identical**.

### Verified

`tests/issue-2571-native-method-generators.test.ts` (10): instance/static/this/
this+param/multi-yield/done/lazy native (zero `__gen_*` imports, correct
values); free `function*` unregressed; capturing + object-literal bail to host
(valid Wasm). tsc + prettier + hard-error gate + IR-fallback gate clean.
Runnable generator/class test files unregressed (the 17 `class-methods.test.ts`
failures are the pre-existing gc-mode `string_constants` harness limitation —
identical on pristine main). Broad-impact → merge_group is the authoritative
full-standalone-shard validator.
