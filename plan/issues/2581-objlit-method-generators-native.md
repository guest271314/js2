---
id: 2581
title: "standalone: object-literal method generators ({ *m(){} }) still leak env.__gen_* — native lowering via closures.ts"
status: ready
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: generators, object-literals
goal: standalone-mode
related: [2571, 2040, 2203, 1665, 2170, 2171]
origin: "Follow-up carved from #2571 (sd-2). #2571 landed native CLASS (instance+static) generator methods; object-literal method generators were intentionally deferred because their emit lives in a different (lifted-closure) path."
---

# #2581 — native object-literal method generators

## Problem

After #2571 (PR #1872), **class** generator methods lower natively in a
no-JS-host target. **Object-literal** method generators still leak the
eager-buffer host runtime:

```ts
// standalone: validates but cannot instantiate (imports env.__gen_*)
export function run(): number {
  const o = { *m() { yield 9; } };
  return o.m().next().value === 9 ? 1 : 0;
}
```

`{ *m(){ yield 9 } }` imports `__gen_create_buffer` / `__create_generator` /
`__gen_next` / … — `WebAssembly.instantiate` fails with `Import #0 "env":
module is not an object or function`.

## Why #2571 deferred it (current state)

#2571 made `isNativeGeneratorCandidate` (`generators-native.ts`) the single
source of truth and **bails an object-literal method generator to the host
path** with:

```ts
if (ts.isMethodDeclaration(decl) && !ts.isClassLike(decl.parent)) return false;
```

So object-literal method generators keep `__gen_*` registered and emit the
eager buffer — a **clean** bail (valid Wasm, no regression, just leaks in
standalone). This issue removes that bail and wires the native path.

## Root cause / why it's a separate slice

Class method generators emit from `class-bodies.ts`, whose collection pass
already builds a typed `this`-bearing method signature — #2571 threaded `this`
as a synthetic leading param (`param_this`) there. Object-literal method
generators are lowered through the **`closures.ts` lifted-closure path**
(`compileNativeGeneratorFunction` is NOT yet called there; the generator
emit at `closures.ts:~2317` builds the eager host buffer). The object-literal
receiver `this` is the object being constructed — its struct type may not be a
clean leading ref param the way a class instance's `this` is, so threading the
receiver needs its own treatment (or an explicit bail when the body reads
`this`, lowering only `this`-free object-literal method generators first).

## Suggested approach

1. In `closures.ts`, at the generator emit site (`isGenerator && ts.isBlock(body)`),
   add a guard: when `(ctx.standalone || ctx.wasi)` and the decl is an
   object-literal `MethodDeclaration` that `isNativeGeneratorCandidate` would
   accept (once the `!isClassLike(parent)` bail is lifted for the wired path),
   register via `registerNativeGenerator` + emit via
   `compileNativeGeneratorFunction`, mirroring `class-bodies.ts`.
2. Receiver handling: start with the `this`-free subset (no synthetic param —
   like a static method). A `this`-reading object-literal method generator can
   stay on the host bail until the receiver type is modelled.
3. Lift the `!ts.isClassLike(decl.parent)` bail in `isNativeGeneratorCandidate`
   ONLY once closures.ts routes the native emit — keep the candidate gate the
   single source of truth so `sourceNeedsGeneratorHostImports` agrees (a
   mismatch bakes an undefined funcidx → invalid wasm, the exact hazard #2571
   hit + fixed).

## Acceptance criteria

- `const o = { *m(){ yield 9 } }; o.m().next().value` compiles to a standalone
  module with **zero `env.__gen_*` imports**, instantiates + runs.
- `this`-reading object-literal method generators either lower natively OR keep
  a clean host bail (no invalid wasm).
- Class + free-function + static generators stay byte-identical (no regression).
- JS-host (gc) mode unchanged.

## Scope note

`feasibility: hard` — the lifted-closure receiver model is the genuinely new
piece. Pairs with #2571 (class methods, landed) and #2040 (generator runtime).
Validate via the full gen-method standalone cluster + merge_group (broad-impact,
NOT a scoped sweep).
