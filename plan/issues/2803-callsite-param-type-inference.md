---
id: 2803
title: "Infer function-parameter types from call-site arguments (usage-based inference) — untyped/.js-stripped params default to `any`"
status: ready
created: 2026-06-28
updated: 2026-07-03
priority: low
feasibility: hard
task_type: feature
area: checker
language_feature: type-inference
goal: platform
sprint: current
related: [389, 2754, 2755]
---

# Infer function-parameter types from call-site arguments

## Problem

js2wasm does not infer a function parameter's type from the types of the
arguments passed at its **call sites**. When a parameter has no annotation —
genuinely untyped JS, or a `.ts` source type-stripped to `.js` (e.g. via
`bun build` / `esbuild`, the loopdive/js2#389 reporter's flow) — the parameter
defaults to `any` and is lowered to the boxed/dynamic representation, **even
when every call site passes a statically-knowable typed value**.

### Motivating case (#389 / #2754)

The native-messaging shared framing code allocates a typed `Uint8Array` and
passes it into the host adapter's callback:

```ts
function denoRead(buf /* : Uint8Array — stripped */) {
  return Deno.stdin.readSync(buf);
}
// ...
new Uint8Array(n); // typed at the allocation site, in nm_sync_framing
read(tmp); // passed into the NmRead callback === denoRead
```

After `bun build` strips the annotations (and the
`NmRead = (buf: Uint8Array) => …` callback type), `denoRead`'s `buf` parameter
is `any`, even though the only thing ever passed to it is a `new Uint8Array(...)`.
The direct `.ts` compile keeps the annotation and works; the transpiled `.js`
does not.

> Note: a runtime `ref.cast` in the readSync/writeSync lowering currently
> recovers the buffer in _that specific_ path (the defensive band-aid tracked
> under #2754), so this inference gap is not necessarily the proximate cause of
> every #389 symptom — the exact `nm_deno` zero-output cause is still being
> pinned (it lowers the buffer fine; the early-EOF is downstream). But a
> parameter statically typed `any` when its call sites are uniformly typed is a
> real root-level capability gap, independent of any one lowering band-aid.

## Scope

**Usage-/call-site-based parameter type inference**: when a function parameter
lacks an annotation, infer its type from the (uniformly-typed) arguments at its
call sites — a whole-program / flow inference pass. Contextual typing of a
_named_ function passed where a typed callback is expected is a related lever
(TS only contextually types inline expressions, not named declarations, and the
callback type itself is erased in `.js`).

This is the **root-level inference** complement to #2754's defensive-correctness
band-aids: with inference the parameter is typed and never boxed in the first
place, removing whole classes of `.js`-strip miscompiles rather than patching
each lowering site.

## Acceptance (sketch)

- A parameter with no annotation, called only with a statically-typed value
  (e.g. `Uint8Array`, a class instance), is inferred to that type instead of
  `any`.
- The type-stripped `.js` of the native-messaging examples compiles the
  buffer/callback parameters to the same typed shape as the `.ts`.
- Byte-neutral where annotations already exist; no regression on existing
  inference paths (validate IN BATCH + `runTest262File`).

## Implementation Plan (banked 2026-07-03 — measured, not yet implemented)

Grounded measurement pass against current `main` (0369c1ee7). Sizing verdict:
**substrate-scale, `feasibility: hard` is accurate** — there is no bounded,
byte-neutral small slice that satisfies the motivating acceptance case. Banked
here so a future window starts from the mechanism, not a rediscovery.

### Key finding: the IR path already does direct call-site param inference

`src/ir/propagate.ts` `buildTypeMap()` is already a whole-program,
call-graph + reverse-graph, worklist-fixpoint over function parameter types.
The forward step literally joins each call site's argument type into the
callee's parameter:

```
// propagate.ts:286-289 (inside the fixpoint)
for (let i = 0; i < newParams.length && i < site.argExprs.length; i++) {
  const argType = inferExpr(site.argExprs[i]!, callerScope, entries);
  newParams[i] = join(newParams[i]!, argType);
}
```

So "infer an untyped param from its uniformly-typed direct call sites" is, for
the IR path and the primitive lattice, **already implemented**. The reason
#2803 still bites is four concrete, independent gaps — each substantial.

### Gap 1 — unannotated param seeds at `DYNAMIC` (top), which absorbs joins

`seedParamType()` (`propagate.ts:369-387`) resolves an unannotated param via
`checker.getTypeAtLocation(param)` → for genuinely untyped / `.js`-stripped
params the checker returns `any` → `tsTypeToLattice` → `DYNAMIC`. The lattice
makes `dynamic` the **top / absorbing** element (`propagate.ts:44-52`:
`anything ⊔ dynamic = dynamic`). So `join(DYNAMIC, argType) = DYNAMIC` — the
call-site refinement at line 288 can **never** lower an unannotated param off
top. Inference only ever refines params that seed at `UNKNOWN` (bottom).

- **Fix direction**: seed _unannotated_ params (no `param.type`, and the
  checker gives `any`) at `UNKNOWN` instead of `DYNAMIC`, so call-site
  evidence can constrain them — while still seeding an **explicit** `any`
  annotation at `DYNAMIC` (an explicit `any` is a deliberate opt-out, must not
  be inferred through).
- **Blast radius**: this is the broad, risky part. It changes the inferred
  representation of _every_ unannotated parameter in _every_ program — a param
  that used to box as dynamic may now lower to a narrow primitive, changing the
  IR selector's claim decision and the emitted Wasm rep across a huge surface.
  Requires full-batch test262 + `runTest262File`, not a scoped check. A param
  with zero visible call sites (exported entrypoints, indirect-only callees)
  would stay `UNKNOWN` and must have a defined default (treat terminal
  `UNKNOWN` as `dynamic` at lowering, matching today's behavior).

### Gap 2 — no typed-array / class-instance lattice element

`LatticeType` is `f64 | i32 | u32 | bool | string | object | unknown |
dynamic` (`propagate.ts:110-135`). `Uint8Array` (the motivating arg type)
collapses to the coarse `object`, not the typed WasmGC array rep the `.ts`
path produces. Even with Gap 1 fixed, `new Uint8Array(n)` inferred as `object`
does not give the buffer the typed lowering #2803's acceptance wants.

- **Fix direction**: extend the lattice with a nominal `object`-subtype
  carrying the concrete type symbol (typed arrays, class instances), and teach
  `inferExpr` to read `new Uint8Array(...)` / `new C(...)` / typed-array
  intrinsics as that element, and `resolvePositionType` (`index.ts:571`) to
  lower it. This is a type-domain expansion, not a one-liner.

### Gap 3 — no higher-order (callback) flow; the motivating case is out of scope

The call graph only records `CallExpression`s whose callee is an `Identifier`
naming a function in the `decls` map (`propagate.ts:239-241`,
`buildCallGraph`). In the motivating case `denoRead` is **never called
directly** — it is passed as the `NmRead` callback and invoked as `read(tmp)`,
where `read` is a _parameter_. That call site's callee is not a top-level decl,
so it is invisible to the graph, and `denoRead`'s `buf` gets no call-site
evidence at all.

- **Fix direction**: track function-valued _bindings_ (a named function
  assigned/passed where a value of function type flows to a param, then called
  via that param) and thread the arg types through the higher-order edge. This
  is genuine higher-order flow analysis — the largest of the four gaps. TS's
  own contextual typing does not help: it only types _inline_ expressions, and
  the `NmRead` callback type is erased in the `.js`.

### Gap 4 — the legacy path has none of this inference

`denoRead` calls `Deno.stdin.readSync` — an external call. The IR selector
rejects external-call / call-graph-closure bodies (see the `external-call`
and `call-graph-closure` fallback buckets in CLAUDE.md's IR-fallback table),
so `denoRead` demotes to the **legacy** front-end, where param types come from
`resolvePositionType(p.type, entry?.params[i], …)` at `src/codegen/index.ts:1322`
— and `entry` is the IR TypeMap, which the legacy path only _reads_; it runs no
inference of its own for functions the selector didn't claim. So even a fully
inferred TypeMap must be plumbed into the legacy param-resolution path (or the
selector must accept these bodies) for the motivating example to benefit.

### Suggested phasing

1. **Phase A (bounded-ish, still needs full test262)**: Gap 1 only — seed
   unannotated params at `UNKNOWN`, terminal-`UNKNOWN`→`dynamic` default.
   Measures the real conformance delta of primitive call-site inference on
   untyped params, in isolation. Gate on batch test262; likely the
   go/no-go signal for the rest.
2. **Phase B**: Gap 2 — typed-array/class-instance lattice element + lowering.
3. **Phase C**: Gap 4 — plumb the inferred TypeMap into legacy param
   resolution (or widen the selector) so non-IR bodies benefit.
4. **Phase D**: Gap 3 — higher-order/callback flow; unlocks the exact #389
   `denoRead`/`read` motivating case.

### Key sites

- `src/ir/propagate.ts`: `buildTypeMap` (fixpoint, :264-343), `seedParamType`
  (:369-387), `buildCallGraph`/inbound edges (:238-259), lattice + `join`
  (:44-52, :110-205).
- `src/codegen/index.ts`: `resolvePositionType` (:571), legacy param loop
  (:1320-1323).
- `src/shape-inference.ts`: adjacent AST-shape inference (separate mechanism;
  not the param-type path but worth cross-checking for overlap).

## Related

- #389 — reporter's `bun build` → `.js` flow where this bites.
- #2754 — sound TS settings for `.ts`/`.js` + codegen defensive-correctness
  (the band-aid layer this complements).
- #2755 — decide the type-soundness approach (trust-the-type vs JS-semantics-first).
