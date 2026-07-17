---
id: 2917
title: "[SUBSTRATE][ARCH] Standalone native `class X extends <Builtin>` super-construction (~10 generic conversions)"
status: ready
updated: 2026-07-17
sprint: fable-final
created: 2026-07-01
priority: medium
horizon: l
feasibility: hard
model: fable
fable_role: spec
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: standalone
related: [1366a, 1455, 1721, 1833, 2029, 2188, 2379, 2395, 2620, 2622, 2709]
origin: "2026-07-01 — sr-tail2 escalation: leaky-PASS conversion cluster, per-builtin backing-instance substrate (representation-scale, à la #2379)"
---

# #2917 — Standalone native `class X extends <Builtin>` super-construction

## Problem (verified on `main` `f350ba855`, 2026-07-01)

`class X extends <Builtin> {}` — where `<Builtin>` is a host-constructible
builtin (`Object`, `Array`, `Function`, `Date`, `RegExp`, …) — lowers
`super(...)` / the implicit derived ctor to a **reflective `__new_<Builtin>`
host import** (`class-bodies.ts:1747`, `:1760`, `:2863`, `:2874`;
`declarations.ts:1602`). Under `--target standalone` there is no JS host, so this
either leaks an unsatisfiable `env::__new_<Builtin>` import (module fails to
instantiate) or, for the Number/Boolean f64-arg mismatch, emits invalid Wasm —
today those are **refused at compile time** (#2029, #2620) rather than run.

This is a **leaky-PASS cluster** (~10 generic conversions): the subclass works in
JS-host mode (the host `extern_class new` resolver builds a real
Array/Date/etc. via `new globalThis[Name](...)`, `runtime.ts:~1604`), but
standalone has no native backing instance. Native super-construction must produce
a **native backing instance** (native `$Object` / `$Vec` / closure / `$Date` /
`$RegExp`) that ALSO carries the subclass's own fields + prototype chain +
`instanceof`, inside the heavily special-cased class-bodies construction
machinery — a **representation-scale problem à la #2379**, high regression risk.

## Scope

**In scope (host-free native backing exists or is cheap):**
`Object`, `Array`, `Function`, `Date`, `RegExp`.

**Explicitly excluded:**
- **Error family** (`Error`, `TypeError`, …) — already host-free via
  `emitWasiErrorConstructor` (#1536c); `class-bodies.ts:1756`, `:2870`.
- **Number / Boolean** — no native primitive-wrapper subclass box (#2029);
  keep the current clean refusal until the value-rep box lands.
- **Set / Map / WeakMap / WeakSet** — native-collection subclass is #2622
  (`[[SetData]]`/`[[MapData]]` set-algebra substrate); keep the #2620 refusal.
- **String** — already compiles standalone (`__new_String` is
  externref-in/externref-out, matches the forwarder — `builtin-tags.ts:287`).
- **TypedArray / ArrayBuffer / DataView / SharedArrayBuffer** — route via
  **#2395's %TypedArray% intrinsic ctor chain** (`#2893` brand, currently OPEN
  PR #2395). Do NOT build a parallel backing here; coordinate / predecessor-stack
  on #2395.

## Background — the construction machinery this must slot into

An `extends <builtin>` subclass is marked **externref-backed**
(`ctx.classExternrefBackedSet`, `ctx.classBuiltinParentMap` —
`class-bodies.ts:660`). Two construction sites both call `__new_<Parent>`:

- **Implicit derived ctor** (no user ctor): `class-bodies.ts:1744–1786` forwards
  the synthetic externref params to `__new_<Parent>(...)`, then
  `emitSetSubclassProto` (`:1781`) + `emitSetSubclassUserBrand` (`:1784`).
- **Explicit `super(...)`**: `compileSuperCall` (`class-bodies.ts:2809`), builtin
  arm at `:2838`; allocates via `__new_<Parent>` (`:2901`), then the same
  proto + brand wiring (`:2922`, `:2925`).

`emitSetSubclassProto` (`class-bodies.ts:416`) itself needs a host
`__set_subclass_proto` and **already no-ops standalone** (`:432`, `:449`) — so
even where construction is faked, the subclass prototype is not wired, and
`instanceof Sub` / own-field access silently break.

The Error family shows the target shape: `emitWasiErrorConstructor` builds a real
`$Error_struct` (tag + message + `.name`), `emitSetSubclassUserBrand`
(`class-bodies.ts`, writes fieldIdx 4) distinguishes siblings (#2188), and
`instanceof` reads those fields natively (#1536c). This issue replicates that
per-builtin.

## Implementation Plan

### Root cause
Externref-backed subclasses of host-constructible builtins have **no native
allocator**: `__new_<Builtin>` is a host import with no standalone body (only the
Error family got `emitWasiErrorConstructor`). `emitSetSubclassProto` also no-ops
standalone, so even a faked instance has no subclass prototype/brand. Net:
leaked import → non-instantiable, or a compile refusal.

### The core design — a per-builtin native backing instance that ALSO carries subclass identity

For each in-scope builtin, `super(...)` must produce a value that is
simultaneously (a) a real builtin instance the parent's methods operate on, and
(b) branded with the subclass's id + prototype so `instanceof Sub` and own-field
reads work. Two representation strategies, per builtin:

- **`Object`** — allocate a native `$Object` open-object struct (via
  `ensureObjectRuntime`'s `__new_plain_object` internal). Own subclass fields
  and `[[Prototype]]` live in the same `$Object` (`$proto` fieldIdx 0). This is
  the cleanest case — `$Object` already has the proto slot the whole
  `__isPrototypeOf` / native-instanceof substrate (#2916) walks.
- **`Array`** — allocate a native `$Vec` (the `__new_vec_*` allocators,
  `index.ts:1718`, `:5607`). `$Vec` has **no proto/brand slot**, so the
  subclass's own fields + brand cannot live inside it. Wrap: a small
  `$Subclass_struct` carrying `{ $brand:i32, $proto, <own fields>, $backing: ref
  $Vec }`, with element reads/`.length` delegating to `$backing`. This is the
  #2379-scale representation decision — pick the wrapper vs. a widened `$Vec`
  with trailing brand fields, and document why.
- **`Function`** — allocate a native closure (the `closures.ts` closure struct).
  Same no-slot problem as `$Vec`; use the same `$Subclass_struct` wrapper with a
  `$backing: closure` field and a call-forward.
- **`Date` / `RegExp`** — allocate the native `$Date` / `$RegExp` backing struct
  (route via the #2671 / #2395 native ctor chain for these builtins). Brand +
  own fields via the wrapper if the backing struct has no spare slot.

**Recommendation:** a single `$Subclass_struct` supertype `{ $brand:i32 (own
class id), $proto (ref null anyref), $backing (anyref) }` extended per subclass
with its own fields, is the uniform representation. `instanceof Sub` (native,
#2916) reads `$brand`; parent-method dispatch unwraps `$backing`; `.prototype`
walks `$proto`. This mirrors how `$Error_struct` field-4 branding already works
(#2188) and keeps the native-instanceof substrate (#2916) uniform.

### Changes

**File: `src/codegen/class-bodies.ts`**
- Add `emitNative<Builtin>SubclassCtor(ctx, arity)` helpers mirroring
  `emitWasiErrorConstructor` — one per in-scope builtin — that build the native
  backing (+ `$Subclass_struct` wrapper) and register a defined `__new_<Builtin>`
  function in `ctx.funcMap` (DEFINED, no import → no index shift).
- In the implicit-derived-ctor path (`:1744`) and `compileSuperCall`'s builtin
  arm (`:2838`), gate on `(ctx.standalone || ctx.wasi) &&
  isHostConstructibleBuiltin(parentName)`: instead of `ensureLateImport(
  "__new_<Parent>")` (`:1760`, `:2874`), call the native ctor helper and take
  its funcIdx — exactly the pattern the Error branch uses at `:1756` / `:2870`.
- **Remove the #2029 / #2620 refusals for the newly-supported builtins only**
  (`:635`, `:605`) — keep Number/Boolean/collections refused. Guard precisely so
  a not-yet-native builtin still refuses cleanly, never leaks / never invalid
  Wasm (the #1888 dual-mode invariant).

**File: `src/codegen/class-bodies.ts` — `emitSetSubclassProto` (`:416`)**
- Give it a native standalone body: when `$Subclass_struct`-backed, write the
  subclass's `$proto` field directly (no host `__set_subclass_proto`), replacing
  the current standalone no-op (`:432`, `:449`). This wires
  `instanceof Sub` (#2916) and the proto chain.

**File: `src/codegen/declarations.ts` (`:1602`)** and **`src/codegen/index.ts`
(`:9774` register-extern-class loop)**
- Ensure the register-`__new_X` path routes the in-scope builtins to the native
  ctor helpers under standalone instead of the host import list.

### Coordinate with #2395 (OPEN PR — %TypedArray% intrinsic ctor chain)
- `Date`/`RegExp`/TypedArray native construction overlaps #2395's ctor-chain and
  #2893 view-brand. **Predecessor-stack**: branch from #2395's real branch once
  it lands (or fresh from post-#2395 main), reuse its native ctor infra rather
  than duplicating. Do NOT branch off the speculative merge-queue tip (#2522).
  If #2395 has not landed, restrict this issue's first slice to `Object` +
  `Array` + `Function` (host-free without the TypedArray brand) and defer
  Date/RegExp to the #2395-stacked follow-up.

### funcIdx / type-index hazards (high regression risk — read carefully)
- **Type-index shift / DCE remap** (`project_type_index_shift_and_deadelim`,
  `reference_subview_type_idx_stability`): the `$Subclass_struct` supertype and
  per-subclass extensions must be **registered up-front / once**, before the
  index-space freeze — a late `ctx.mod.types.push` after DCE remaps corrupts
  every baked struct type idx. Reserve the supertype idx at runtime-init time.
- **Late-import funcIdx desync** (`reference_1461_*`, `reference_2193_*`,
  `project_standalone_hostimport_gate_index_shift`): the native ctor helper is a
  DEFINED function (no import shift), but if it internally `ensureLateImport`s
  anything (e.g. a native-string helper), `flushLateImportShifts` must run and
  the synthetic `<Class>_new` forwarder's baked call funcIdx must be repointed
  by NAME, not a captured integer. This is the exact #2043 desync that made
  `extends Set` invalid Wasm (#2620) — the reason collections are refused today.
- **Body-swap discipline** (`project_brand_check_swap_savedbodies`): building the
  ctor body inside the active function must use `pushBody`/`popBody`, never a
  shared `Instr[]` aliased into two branches (`reference_shared_instr_object_dce_double_remap`).
- **Arg-type match**: the synthetic forwarder passes externref locals; the native
  ctor's param types MUST be externref-in (the #2029 f64 mismatch is exactly why
  Number/Boolean are excluded). Keep every in-scope ctor externref-in/externref-out.

### Edge cases
- `class X extends Array { constructor(){ super(); this.own = 1; } }` — own field
  `this.own` writes must land in the `$Subclass_struct`, element ops delegate to
  `$backing` `$Vec`. Verify `new X().length`, `new X()[0]=…`, and `x.own`.
- Multi-level chain (`class B extends A {}`, `A extends Array`) — thread the
  SAME builtin ancestor's native ctor (mirror `class-bodies.ts:663–683`), brand
  with B's id.
- `super(...args)` spread — non-literal spread is still arity-truncated (#1833 /
  #1551); keep the existing best-effort, do not regress.
- `new X() instanceof X` AND `instanceof <Builtin>` must both be true — the
  `$brand` (own id) + the backing type both answer, consumed by #2916's native
  instanceof.
- gc/host mode: every native arm gated `ctx.standalone || ctx.wasi` — the
  externClass host path stays byte-identical.
- Uninitialised-`this` before `super()` (#2709) — unchanged; native ctor still
  runs at the `super()` site.

### Regression-risk mitigation
- **Byte-inert for gc/host**: all native ctor / proto-write arms gated
  `ctx.standalone || ctx.wasi`; the host externClass path is untouched.
- **Per-builtin, incremental**: land `Object` first (cleanest — reuses `$Object`
  proto slot, no wrapper), then `Array`, then `Function`, then Date/RegExp
  (#2395-stacked). Each builtin is an independently-shippable slice with its own
  corpus check — do NOT big-bang all five.
- **Refuse, never mis-emit**: any builtin not yet native keeps a clean CE — never
  a leaked import, never invalid Wasm (the #1888 invariant; the #2043 lesson).
- **Full `merge_group` validation** (representation-scale, broad impact —
  `project_broad_impact_validate_full_ci`): watch the standalone floor + object
  identity (`reference_standalone_floor_object_identity_and_real_vs_drift`) —
  the backing-wrapper must preserve `ref.eq` object identity.

### Corpus-verify plan
- Leak-probe (#2907 methodology) over `test/language/statements/class/subclass-builtins/`
  and `built-ins/Array/Symbol.species` / `Object` subclass tests, `--target
  standalone`, per builtin: count `env::__new_<Builtin>` leaks → 0, confirm
  instantiation host-free.
- Assert `new X() instanceof X`, `new X() instanceof <Builtin>`, own-field
  round-trip, and (Array) element/`.length` delegation.
- `net_per_test > 0`, ratio < 10%, no bucket > 50 on the standalone shard.
- Regression control: `extends Error` (#1536c) and `extends String` stay green;
  Number/Boolean/collections still refuse cleanly.

### Split recommendation
**Split per-builtin — this is NOT one focused effort.** Recommended order (each a
separate dev slice, shared `$Subclass_struct` substrate spec'd here):
1. `extends Object` (medium — reuses `$Object`, no wrapper).
2. `extends Array` (large — `$Vec` wrapper + delegation, #2379-scale).
3. `extends Function` (large — closure wrapper + call-forward).
4. `extends Date` / `extends RegExp` (medium — #2395-stacked).

## Acceptance
- `class X extends {Object,Array,Function,Date,RegExp}` compiles + instantiates
  host-free under `--target standalone` (zero `env::__new_*`).
- `new X() instanceof X` and `instanceof <Builtin>` both true; own fields +
  (Array) element/`.length` delegation work.
- gc/host byte-identical; Number/Boolean/collections still refuse cleanly.
- `net_per_test > 0`; full `merge_group` net-positive; object identity preserved.
