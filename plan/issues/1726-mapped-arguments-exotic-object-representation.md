---
id: 1726
title: "spec gap: mapped `arguments` exotic-object representation (§10.4.4)"
status: ready
created: 2026-05-29
updated: 2026-05-29
feasibility: hard
area: codegen, runtime
language_feature: arguments-object
goal: test262-conformance
sprint: Backlog
parent: 1511
related: [1511, 849, 779e, 1053, 1382]
---
> **ID-collision note (read first):** the numeric id `1432` is *already in
> use* by the **done** issue
> `plan/issues/1432-spec-gap-parameter-list-rest-destructuring.md` (merged
> in commit `260f3df16`, sprint 52). That issue is unrelated
> (parameter-list rest/destructuring iterator semantics). The "(#1726
> follow-up)" back-reference inside `1511`'s *Out of scope* note was a
> mistaken citation. This file carries `id: 1432` per the spawning
> instruction, but the **on-disk slug is distinct**
> (`1432-mapped-arguments-exotic-object-representation.md`) so the existing
> done issue is not clobbered. **Tech lead: please reassign this a fresh
> unique id when scheduling** (suggest `1715` or next free) to avoid two
> `id: 1432` files. The spec body below is id-agnostic.

# mapped `arguments` exotic-object representation (§10.4.4)

## Problem

Escalated from #1511. The trailing-comma / `arguments.length` /
legacy-ES3 clusters are already fixed (PR #373 plus #1511's first pass).
The residual **~30 `language/arguments-object/mapped/*`** test262 failures
need a *representation change*, not a localized patch:

- `Object.getOwnPropertyDescriptor(arguments, "0")` must return the
  correct attribute set (`writable`, `enumerable: true`, `configurable`)
  for an indexed slot, and `{ value, writable: false, enumerable: false,
  configurable: true }` for `length`, `{ enumerable: false, ... }` for
  `callee` (sloppy) / a poison accessor (strict).
- `Object.defineProperty(arguments, "0", …)` must apply ordinary
  `[[DefineOwnProperty]]` semantics **and**, per §10.4.4.2, break the
  parameter↔slot mapping when the redefinition makes the slot
  non-writable, turns it into an accessor, or changes its value while
  also clearing writability.
- `delete arguments[i]` must remove the slot **and** break the mapping
  for that index (§10.4.4.5).
- For *mapped* slots (sloppy mode + simple parameter list), reads/writes
  of `arguments[i]` and of the named parameter must stay **two-way
  linked** until the link is broken.

Today `arguments` is a raw WasmGC vec struct built in
`src/codegen/function-body.ts` (~L808–845). It has:

- no per-slot attribute storage (so `getOwnPropertyDescriptor` returns
  array-element defaults via the runtime fallback, with wrong
  `enumerable`/`configurable`),
- no `[[ParameterMap]]` object — the param↔slot link is an *ad-hoc*
  codegen-time mechanism (`fctx.mappedArgsInfo` +
  `emitMappedArgParamSync` / `emitMappedArgReverseSync`) that has **no
  runtime-visible "is this slot still linked" flag**, so a
  `defineProperty`/`delete` performed at runtime cannot break the link
  the compiler hard-wired into the param-write path.

## ECMA-262 §10.4.4 model (the contract to implement)

An Arguments exotic object `args` has an internal slot `[[ParameterMap]]`
— itself an ordinary object whose own keys are the *string* index of each
**mapped** slot, each key bound to a magic getter/setter pair over the
corresponding environment binding (the named parameter).

- `[[Get]](P)` / `[[Set]](P,V)`: if `P` is a key of `[[ParameterMap]]`,
  read/write goes through the magic accessor (live link to the param);
  otherwise ordinary.
- `[[GetOwnProperty]](P)`: ordinary descriptor, but if `P` is in
  `[[ParameterMap]]` the returned `desc.[[Value]]` is overwritten with
  the *current* mapped value (the slot may have been redefined to a
  different stored value, yet still reads live until unmapped).
- `[[DefineOwnProperty]](P, Desc)`: do the ordinary define; **then** if
  `P` is mapped:
  - `IsAccessorDescriptor(Desc)` ⇒ delete `P` from `[[ParameterMap]]`
    (unmap).
  - else: if `Desc.[[Value]]` present ⇒ `map.[[Set]](P, Desc.[[Value]])`
    (push value to the param); if `Desc.[[Writable]] === false` ⇒ delete
    `P` from `[[ParameterMap]]` (unmap).
- `[[Delete]](P)`: ordinary delete; if it succeeded and `P` was mapped,
  delete `P` from `[[ParameterMap]]` (unmap).

Only **mapped** functions get the `[[ParameterMap]]`. A function is
mapped iff: **sloppy mode** (no `"use strict"`, not a class
body/module) **and** a **simple parameter list** (every parameter a bare
identifier; no defaults, no rest, no destructuring). Strict-mode or
complex-parameter-list functions get an **unmapped** arguments object:
plain data properties (indexed slots `writable:true, enumerable:true,
configurable:true`), `length` `{writable:true,enumerable:false,
configurable:true}`, a `@@iterator`, and a poison `callee` accessor —
**no linkage at all**.

This matches the existing codegen gate
`mappedAllowed = allSimpleParams && !isStrictFunction(decl)`
(`function-body.ts:822–823`) — keep that exact predicate as the
mapped/unmapped switch.

## Implementation Plan

### Chosen representation

**Keep the cheap vec for the hot path; lazily materialize an exotic
backing object only when a function *reflectively* touches `arguments`.**

Three tiers, selected at compile time per function:

1. **No `arguments` use** (the overwhelming majority): unchanged. No
   `arguments` local is built (`bodyUsesArguments` already gates this at
   `function-body.ts:799`). Zero cost.

2. **`arguments` used non-reflectively** (read `arguments[i]`,
   `arguments.length`, spread, pass to a callee, index in a loop): keep
   **today's vec struct** plus the existing `mappedArgsInfo` two-way sync
   for mapped functions. No exotic object, no descriptor map, no
   regression. This is the common `arguments` path and MUST stay on the
   vec.

3. **`arguments` used reflectively** (the body contains
   `Object.defineProperty(arguments, …)`,
   `Object.getOwnPropertyDescriptor(arguments, …)`,
   `Object.defineProperties`/`getOwnPropertyDescriptors` on `arguments`,
   `delete arguments[…]`, `Object.freeze/seal/preventExtensions` on
   `arguments`, `Reflect.*` on `arguments`, or `arguments` flowing into a
   call whose callee is one of those): build the **exotic arguments
   object** with a runtime-visible `[[ParameterMap]]` and per-slot
   attributes.

#### Gating / detection strategy (explicit)

Add a compile-time analysis pass `argumentsReflectionMode(body): "none" |
"vec" | "exotic"` in a new helper
`src/codegen/helpers/arguments-reflection.ts`, memoized with the same
`WeakMap` pattern as `bodyUsesArguments`. It runs the same iterative DFS
(skipping nested non-arrow functions) and returns `"exotic"` when it sees
any of the reflective shapes above with `arguments` as the (statically
resolvable) receiver. Detection is **conservative**: when in doubt
(e.g. `arguments` aliased into a variable, then passed somewhere
opaque), return `"exotic"` — correctness over speed, but only for the
already-rare reflective case. `"vec"` when `arguments` is used but never
reflectively; `"none"` when unused (delegates to `bodyUsesArguments`).

Wire it in `function-body.ts:799`:

```ts
const argMode = bodyUsesArguments(decl.body) ? argumentsReflectionMode(decl.body) : "none";
if (argMode !== "none") { /* build arguments */ }
```

The `"vec"` branch is the current code verbatim. The `"exotic"` branch
builds the exotic object (below). Because tier-3 is gated on a syntactic
pattern that essentially never appears in hot code, **the common path
keeps the vec and cannot regress**.

> Note on soundness of compile-time gating: aliasing `arguments` into a
> field/closure and reflecting on it elsewhere is the one case the DFS
> can miss. The conservative fallback (any `arguments` escape into an
> opaque call ⇒ `"exotic"`) covers it. If even that proves leaky in
> test262, the fallback is to make tier-2's vec itself carry the
> descriptor map (collapse tiers 2 and 3) — but do NOT do that
> pre-emptively; it would tax the hot path. Measure first (see Risks).

### Exotic-object data model (tier 3)

The exotic arguments object is a **runtime-backed object**, not a vec.
Mirror the existing runtime exotic/struct + tombstone machinery
(`src/runtime.ts` `__defineProperty_desc` at ~L5174,
`__getOwnPropertyDescriptor` at ~L5434, `__delete_property` at ~L6717,
and the deleted-field tombstone set described at runtime.ts ~L434). The
arguments object reuses that ordinary-object property/descriptor store;
the **only** arguments-specific addition is a side `[[ParameterMap]]`.

Concrete layout (host-mode; standalone-mode fallback noted):

- The exotic arguments value is created by a new runtime import
  `__create_mapped_arguments(argc, paramCount, linkSetter, linkGetter,
  envHandle)` returning an `externref`. In **host (JS) mode** it builds a
  plain JS object whose indexed slots, `length`, `callee`, and
  `@@iterator` are installed with the spec attribute sets via real
  `Object.defineProperty`, and whose `[[ParameterMap]]` is implemented
  with native getter/setter pairs that call back into the module to
  read/write the i-th parameter local. The two-way link is therefore
  expressed as *real JS accessors*, so native
  `Object.defineProperty`/`getOwnPropertyDescriptor`/`delete` on the
  object Just Work and break the link exactly per §10.4.4 (deleting the
  accessor pair == unmapping).
- The "callback into the module" for slot `i` is a pair of exported
  thunks. Reuse the **ref-cell** pattern (CLAUDE.md "Ref cells for
  mutable closure captures — `struct (field $value (mut T))`"): for a
  function in tier-3, force its mapped parameters into ref cells at
  entry, and pass the ref-cell refs (as an `externref` vec, the
  `envHandle`) to `__create_mapped_arguments`. The JS getter does
  `__refcell_get(envHandle, i)`; the setter does
  `__refcell_set(envHandle, i, v)`. Reads of the *named parameter*
  inside the body must also go through the ref cell for tier-3 functions
  (so the param sees writes made via `arguments[i]`). This subsumes the
  ad-hoc `emitMappedArgParamSync`/`ReverseSync` for tier-3 (see
  "Interaction" below).
- **`length`** stored as a normal own data property
  `{value: argc, writable:true, enumerable:false, configurable:true}`.
  **`callee`**: sloppy ⇒ data property pointing at the function value
  (or, where the function value isn't reified, a poison accessor — match
  what other exotic objects do); strict-eligible code never reaches
  tier-3 anyway. **`@@iterator`** = `Array.prototype.values` equivalent
  (reuse the array iterator the runtime already installs).
- **Standalone (pure-Wasm) mode fallback**: JS accessors aren't
  available. Represent the exotic arguments as a WasmGC struct
  `(field $slots (ref $vec)) (field $attrs (ref $attrVec))
  (field $linked (ref $i31vec-or-bitset)) (field $env (ref $refcellVec))`
  where `$attrs` holds a per-slot packed attribute byte (w/e/c bits) and
  `$linked` is the bitset of still-mapped indices. The
  `__defineProperty_desc` / `__getOwnPropertyDescriptor` /
  `__delete_property` runtime helpers gain an arguments-exotic branch
  (guarded by `ref.test` on the arguments struct type) that consults
  `$attrs`/`$linked` and, on unmap, clears the `$linked` bit. Slot
  get/set consult `$linked[i]` to decide whether to also read/write
  `$env[i]` (the ref cell). This is the dual-mode obligation from
  CLAUDE.md ("New features should have Wasm-native implementations for
  standalone mode"). The host-mode JS-accessor path is the fast path;
  the struct+bitset path is the standalone fallback. **Both implement
  the same §10.4.4 unmap rules.**

### How a slot's mapping is broken

The single source of truth for "is slot i linked" is:
- host mode: whether the `[[ParameterMap]]` (a real JS object) still has
  own key `String(i)` as an accessor;
- standalone mode: the `$linked` bitset.

Unmapping happens in exactly three runtime code paths, each already a
single function:
1. `__defineProperty_desc` — after the ordinary define, if `i` was
   linked and (`IsAccessorDescriptor(desc)` || `desc.writable === false`)
   ⇒ unmap `i`. If a value was supplied, push it to the param *before*
   unmapping when only-value (writable unchanged), per §10.4.4.2.
2. `__delete_property` — if delete succeeded and `i` was linked ⇒ unmap.
3. (no third site for arguments specifically; `freeze`/`seal` reach
   tier-3 via `defineProperty` per-slot in the runtime's existing freeze
   implementation — verify that path iterates slots through
   `__defineProperty_desc` so the unmap fires; if freeze writes
   attributes directly, add the unmap there too).

### Exact functions / files / line numbers to change

**`src/codegen/helpers/arguments-reflection.ts`** — NEW. Export
`argumentsReflectionMode(node): "none" | "vec" | "exotic"`. Mirror
`helpers/body-uses-arguments.ts` (WeakMap memo, iterative DFS, skip
nested non-arrow functions). Detect reflective shapes listed above.

**`src/codegen/function-body.ts`**
- L799: replace the `bodyUsesArguments(decl.body)` guard with the
  three-tier `argMode` switch (above). The `"vec"` branch is L800–845
  unchanged.
- Add an `"exotic"` branch: force mapped params into ref cells (only for
  tier-3, only the simple/mapped params), build the `envHandle` vec of
  ref-cell refs, then `call __create_mapped_arguments`, store the
  resulting externref into the `arguments` local (which becomes
  `externref`-typed in tier-3, not `vecRef`). Set a new
  `fctx.exoticArgsInfo` (see types.ts) instead of `mappedArgsInfo`.

**`src/codegen/context/types.ts`** (~L285)
- Add `exoticArgsInfo?: { argsLocalIdx: number; paramCount: number;
  paramOffset: number; envHandleLocalIdx: number; refCellLocalIdx:
  number[]; }` alongside `mappedArgsInfo`. Only one of the two is set per
  function (vec vs exotic).

**`src/codegen/expressions/logical-ops.ts`** (`emitMappedArgParamSync`
~L288, `emitMappedArgReverseSync` ~L348)
- Leave the vec-path functions as-is (tier 2). For tier 3, param writes
  go through the ref cell directly (no array.set into a vec), so add a
  small `emitExoticArgParamWrite` that does `__refcell_set(env, i, v)`;
  the reverse direction is handled entirely by the JS accessor / standalone
  `$linked` check, so there is **no** reverse-sync emission in tier 3 — the
  link is consulted at access time, not pushed.

**`src/codegen/expressions/assignment.ts`** (L2606, L2734)
- These call `emitMappedArgReverseSync` for the vec path. Add a tier-3
  branch: when `fctx.exoticArgsInfo` is set and the target is
  `arguments[...]`, route the write through the runtime
  `[[Set]]` (a new `__arguments_set(args, i, v)` import) so the
  `[[ParameterMap]]` (or `$linked`) decides whether the param updates.
  Reads of `arguments[i]` in tier 3 likewise go through
  `__arguments_get(args, i)` rather than `struct.get` on a vec.

**`src/codegen/closures.ts`** and **`src/codegen/expressions/new-super.ts`**
(`liftedFctx.mappedArgsInfo` ~L1207) and
**`src/codegen/statements/nested-declarations.ts`** (~L1237)
- Each of these *also* builds `arguments` / sets `mappedArgsInfo` for
  lifted/closure/nested contexts. Each must compute `argumentsReflectionMode`
  for its own body and, when `"exotic"`, take the exotic branch too.
  Audit all four `mappedArgsInfo`-assignment sites; none may silently
  stay on the vec when the body reflects.

**`src/runtime.ts`**
- New import `__create_mapped_arguments` (host: builds JS object with
  accessor `[[ParameterMap]]`; see model above). Place near the other
  object-construction helpers.
- New imports `__arguments_get(args, i)` / `__arguments_set(args, i, v)`
  for tier-3 slot access (host: plain `[[Get]]`/`[[Set]]`; standalone:
  struct + `$linked` logic). New `__refcell_get`/`__refcell_set` if not
  already present (reuse existing ref-cell helpers if they exist —
  grep `RefCell`/`getOrRegisterRefCellType` in
  `src/codegen/registry/types.ts`, already imported by object-ops).
- `__defineProperty_desc` (~L5174): add the §10.4.4.2 unmap step when the
  receiver is an exotic arguments object.
- `__getOwnPropertyDescriptor` (~L5434): add the §10.4.4.1 live-value
  overwrite for mapped slots. For host mode the JS accessors already
  yield the live value, so this is mostly the standalone path.
- `__delete_property` (~L6717): add the §10.4.4.5 unmap step.
- `__create_unmapped_arguments` (host): for strict / complex-param-list
  functions that *also* reflect — plain data-property object, no
  `[[ParameterMap]]`. (Strict tier-3 is rare but real:
  `mapped/.../strict-delete-*.js` tests exercise the *unmapped* delete
  semantics.)

### Wasm IR pattern (tier-3 slot read/write, standalone fallback)

```wasm
;; arguments[i]  read  (tier 3, standalone)
local.get $args                ;; ref $ArgsExotic
local.get $i
call $__arguments_get          ;; consults $linked[i]; if linked → reads $env[i] refcell

;; arguments[i] = v  write (tier 3, standalone)
local.get $args
local.get $i
local.get $v
call $__arguments_set          ;; if $linked[i] → also __refcell_set($env,i,v)
```

```wasm
;; unmap on defineProperty(writable:false) — inside __defineProperty_desc
local.get $args
ref.test $ArgsExotic
if
  ;; if desc makes slot non-writable or accessor:
  local.get $args
  struct.get $ArgsExotic $linked
  local.get $i
  ;; clear bit i
  call $__bitset_clear
end
```

### Edge cases

- **Re-mapping is one-way**: once unlinked a slot never re-links, even if
  a later `defineProperty` restores `writable:true`. (§10.4.4 only ever
  *deletes* from `[[ParameterMap]]`.)
- **defineProperty with only `value` (writable unchanged & still
  writable)**: push value to the param, keep the link. With
  `writable:false`: push value (if present) *then* unmap.
- **`delete arguments[i]` then re-create `arguments[i] = x`**: the new
  property is a plain unmapped data property; param is not touched.
- **Out-of-range index** (`i >= argc`): ordinary object semantics, never
  mapped.
- **`arguments.length` write**: ordinary; never affects slots/params.
- **Strict + tier-3** (e.g. `"use strict"` function calling
  `Object.getOwnPropertyDescriptor(arguments,0)`): unmapped object,
  `callee` is the poison accessor, indexed slots are writable/enumerable
  data props with NO param link.
- **Numeric `param` aliasing under coercion**: tier-3 forces mapped
  params into ref cells; ensure numeric (f64/i32) params box/unbox
  through the ref cell consistently (reuse the existing
  `__box_number`/`__unbox_number` coercion already wired at
  `function-body.ts:800–805` and in `emitMappedArg*Sync`).
- **Generators / async**: `arguments` inside a generator body is built in
  the eager-eval prologue (function-body.ts generator branch ~L848); the
  tier decision must be made there too. Likely defer tier-3 inside
  generators to a follow-up if it complicates the buffer machinery —
  note it, don't silently produce wrong results (fall back to throwing
  an unsupported diagnostic rather than emitting a vec that lies about
  descriptors).

### Interaction with #1511 and dev-a's in-flight slice

#1511 (status `review`) shipped the **trailing-comma length** fix and
explicitly deferred "Mapped slot defineProperty fidelity … needs a
'linked' bitset on the arguments struct". Dev-a's localized link-break
slice on #1511 adds that **bitset on the vec struct** to break the link
for `defineProperty(writable:false)`/`delete` *in the common vec path*.

**This spec subsumes that slice, it does not contradict it:**
- The dev-a bitset is exactly the tier-3 standalone `$linked` field,
  promoted from an ad-hoc add-on into the documented exotic
  representation. If dev-a lands first, tier-3's standalone struct should
  **reuse the same bitset field and the same unmap call sites**
  (`__defineProperty_desc` / `__delete_property`) rather than inventing a
  parallel one.
- The difference: dev-a's slice keeps the *vec* as the object and bolts a
  bitset on; this spec makes the reflective case a *first-class exotic
  object* with full descriptor attributes (so
  `getOwnPropertyDescriptor` returns correct `enumerable`/`configurable`,
  not just correct link-break behavior). The vec-with-bitset is a valid
  *intermediate* that fixes the `writable:false`/`delete` link-break
  tests; this issue closes the remaining descriptor-attribute and
  accessor-redefine tests.
- **Action**: when scheduling, land dev-a's #1511 slice first; then this
  issue refactors the bitset into `exoticArgsInfo` and adds the
  descriptor-attribute fidelity + host-mode accessor `[[ParameterMap]]`.
  Do NOT duplicate the bitset.

## Risks + regression guard (mandatory)

This touches the function-entry hot path. The tier gate is the safety
mechanism: tiers 1 and 2 are byte-for-byte the current codegen, so the
*only* code that changes shape is functions that reflect on `arguments`
(near-zero in real code, a handful in test262).

Required before merge:
- **Full CI net read, net ≥ 0.** Watch specifically for `wasm_compile`
  regressions (the new ref-cell forcing of params in tier-3 must not leak
  into tier-2; assert via a test that a plain `function f(a){return
  arguments[0]+a}` still compiles to the vec path with NO ref cells).
- **Runtime regressions across every function that uses `arguments`** —
  the `argumentsReflectionMode` classifier must default to `"vec"` for
  all current `arguments` users; add a unit test enumerating
  non-reflective shapes (index read, `.length`, spread, for-of, pass to
  callee) and asserting `"vec"`.
- Watch `language/arguments-object/` *non-mapped* subdirs for collateral
  regressions from the classifier mis-firing.
- Confirm `tests/issue-1511.test.ts` and
  `tests/equivalence/arguments-object*.test.ts` still pass (tier-2 path
  untouched).
- Standalone (`--target wasi` / `nativeStrings`) build of a tier-3
  function must compile and run — the dual-mode obligation. Add one WASI
  equivalence case.

## Acceptance criteria

1. ≥ 25 of the ~30 `language/arguments-object/mapped/*` cases flip to
   `pass`, including:
   - `mapped/nonconfigurable-nonwritable-descriptors-basic.js`
   - `mapped/mapped-arguments-nonconfigurable-strict-delete-1.js`
   - `mapped/*defineProperty*accessor*` (accessor-redefine unmaps)
   - `mapped/getownproperty-*` (correct attribute set).
2. No regression in `tests/equivalence.test.ts` and no `wasm_compile`
   regression in any `arguments`-using function (tier-2 path proven
   unchanged by the classifier unit test).
3. Standalone-mode tier-3 compiles and runs (dual-mode).
4. CI net ≥ 0.

## Reference tests

- `language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-basic.js`
- `language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js`
- `language/arguments-object/mapped/getownproperty-mapped-name.js`
- `language/arguments-object/mapped/extensible-with-new-args-frozen-and-mapped.js`
- (full residual list: `grep -rl mapped test262/test/language/arguments-object/mapped`)
