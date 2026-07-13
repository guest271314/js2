---
id: 3238
title: "Standalone: native constructor for `class extends Object` (drop __new_Object host leak)"
status: done
assignee: opus-leak2
completed: 2026-07-13
sprint: 71
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
related: [56, 3053, 1536, 2902]
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/class-bodies.ts
---

## Problem

Under `--target standalone`, `class Sub extends Object { … }` lowers the parent
construction (`super()` / implicit default derived ctor) to a host import
`env::__new_Object`. Standalone has no JS host, so the import leaks: the module
still *passes* (a host shim satisfies the import in the test harness), but it is
counted as a host-import leak, not `host_free_pass`.

Re-ranking the fresh standalone baseline (2026-07-13, 4,231 leaky passes) showed
the bounded declared-but-uncalled GATE seam (the #3016 pattern) is **exhausted**
(0 gates / 200 sampled leaky passes — every leak genuinely calls its import).
The next lever is **substrate**: the biggest distinct, non-excluded, non-deferred
cluster is `__new_*` subclass-builtins (49 sole-import host-free flips). This
issue takes the **first per-builtin slice: `Object`** (4 flips), which builds
directly on the existing native `$Object` / `__new_plain_object` substrate
(#56 native $Object alloc + subclass proto/brand/instanceof; #3053 substrate).

Affected tests (sole import `env::__new_Object`):
- `language/statements/class/subclass-builtins/subclass-Object.js`
- `language/expressions/class/subclass-builtins/subclass-Object.js`
- `language/statements/class/subclass/builtin-objects/Object/replacing-prototype.js`
- `language/expressions/delete/super-property.js` (explicit `super()` + `delete super.x`)

## Root cause

`src/codegen/class-bodies.ts` lowers builtin-parent construction to
`ensureLateImport(ctx, "__new_<Parent>", …)` at two sites:
- **implicit** default derived ctor (externref-backed, no user ctor) — ~L1769
- **explicit** `super(...)` in a user ctor — ~L2928

For the Error family, #1536c/#2902 already special-case
`(ctx.wasi || ctx.standalone) && isWasiErrorName(parent)` → `emitWasiErrorConstructor`
(a native `$Error_struct` builder, no host import). `Object` had no such native
path, so it fell through to the leaking `ensureLateImport`.

## Fix

Per §20.1.1.1 `Object ( [ value ] )`: when NewTarget is a subclass (neither
undefined nor `%Object%`), the `value` argument is **ignored** and the result is
`OrdinaryCreateFromConstructor(NewTarget, "%Object.prototype%")` — a fresh
ordinary object whose [[Prototype]] is the subclass's prototype. So routing
`super(value)` to a fresh native plain object (`__new_plain_object()`) and then
letting the existing `emitSetSubclassProto` / `emitSetSubclassUserBrand` fix the
prototype/brand is **spec-correct** (arg side effects are still evaluated at the
call site, then dropped inside the native ctor).

New helper `emitStandaloneObjectConstructor(ctx, argCount)` in
`src/codegen/object-runtime.ts`:
- idempotent on `__new_Object`
- `ensureObjectRuntime(ctx)` (registers `__new_plain_object`)
- registers a defined func `__new_Object : (externref × argCount) -> externref`
  whose body ignores its params and tail-returns `call __new_plain_object`

Both call sites gain a branch **before** the `ensureLateImport` fallback:
`else if ((ctx.wasi || ctx.standalone) && parentName === "Object")` →
`emitStandaloneObjectConstructor(ctx, arity); funcIdx = ctx.funcMap.get("__new_Object")`.

## Constraints

- **Host/gc lane byte-identical** — the new branch is gated on
  `ctx.standalone || ctx.wasi`; host mode keeps the `__new_Object` import.
- **NET ≥ 0** — Object-subclass tests currently leak (not host-free), so they
  can only flip to host-free or stay; verify no standalone floor regression.
- First per-builtin slice only. Follow-ups (per coordinator): RegExp/Array/
  Function/Date/AggregateError/TypedArray as separate PRs building on the same
  substrate.

## Acceptance

- The 4 `__new_Object`-sole tests compile host-free (no `env::__new_Object`) and
  still pass.
- Scoped standalone sweep shows no regression.
