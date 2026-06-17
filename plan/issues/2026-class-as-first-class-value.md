---
id: 2026
title: "classes are not first-class values: new K() on a parameter throws 'No dependency provided for extern class', .constructor identity broken"
status: blocked
sprint: 63
created: 2026-06-10
updated: 2026-06-17
blocked_on: architect-spec (uniform construct-ABI for dynamic `new`)
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

## Re-validation 2026-06-17 (dev-mech1, vs upstream/main @ 79e16bb37)

Re-validated the three repros via `compileAndInstantiate`:

| Repro | Result on upstream/main |
|---|---|
| `new K()` on a param-bound class (`make(C).m()`) | **STILL FAILS** — `Error: No dependency provided for extern class "K"` |
| `new A().constructor === A` | **PASSES** (fixed since, via #1116b/#1395) |
| `new C()` direct on class expression | PASSES |

So only the **dynamic `new` through a value** half remains. The
`.constructor` identity half is already done.

### Why this is architect-scale, not a dev slice — routed to architect

Root cause confirmed at `src/codegen/expressions/new-super.ts`: `compileNewExpression`
derives `className` from the checker symbol (line ~2790). For `new K()` where
`K` is a parameter typed `any`, no class symbol resolves, so `className === "K"`,
which is absent from `ctx.classSet` and `ctx.externClasses`; execution falls
through to the **extern-class import intent**, which `src/runtime.ts:6230`
rejects at instantiation.

A class used as a *value* is already lowered to a **closure struct whose first
field is the ctor `funcref`** (`emitClassCtorValue` → `emitFuncRefAsClosure`,
`new-super.ts:1559` / `closures.ts:3285`), wrapped as externref. The descriptor
the fix-direction asks for therefore largely **exists**. The blocker is the
**constructor ABI**: each `<Class>_new` returns a *concrete* `(ref $Struct)` and
the closure wrapper type uses the *user-facing* call signature — there is no
uniform "construct → anyref/externref instance" entry point to `call_ref` at a
site that doesn't statically know the struct. Making `new <dynamic>` work
requires a **uniform boxed-instance constructor ABI** (every ctor reachable via
a value exposes a `() -> externref` / `(...args) -> externref` construct
trampoline, instances boxed uniformly), plus dispatch through the closure's
funcref slot. That is a cross-cutting representation change touching every
class-construction path and the new.target machinery (#2023) — exactly the
"one architect spec for the family" the issue's fix-direction calls for.

**Recommendation:** this `feasibility: hard` issue is now **blocked on an
architect Implementation Plan** for the uniform construct-ABI. A partial codegen
hack risks regressing the well-functioning static-class path for marginal gain.
No open PR covers #2026 (checked `gh pr list -R loopdive/js2 --search "#2026"`).
