---
id: 2803
title: "Infer function-parameter types from call-site arguments (usage-based inference) — untyped/.js-stripped params default to `any`"
status: ready
created: 2026-06-28
updated: 2026-06-30
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
function denoRead(buf /* : Uint8Array — stripped */) { return Deno.stdin.readSync(buf); }
// ...
new Uint8Array(n)   // typed at the allocation site, in nm_sync_framing
read(tmp)           // passed into the NmRead callback === denoRead
```

After `bun build` strips the annotations (and the
`NmRead = (buf: Uint8Array) => …` callback type), `denoRead`'s `buf` parameter
is `any`, even though the only thing ever passed to it is a `new Uint8Array(...)`.
The direct `.ts` compile keeps the annotation and works; the transpiled `.js`
does not.

> Note: a runtime `ref.cast` in the readSync/writeSync lowering currently
> recovers the buffer in *that specific* path (the defensive band-aid tracked
> under #2754), so this inference gap is not necessarily the proximate cause of
> every #389 symptom — the exact `nm_deno` zero-output cause is still being
> pinned (it lowers the buffer fine; the early-EOF is downstream). But a
> parameter statically typed `any` when its call sites are uniformly typed is a
> real root-level capability gap, independent of any one lowering band-aid.

## Scope

**Usage-/call-site-based parameter type inference**: when a function parameter
lacks an annotation, infer its type from the (uniformly-typed) arguments at its
call sites — a whole-program / flow inference pass. Contextual typing of a
*named* function passed where a typed callback is expected is a related lever
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

## Related

- #389 — reporter's `bun build` → `.js` flow where this bites.
- #2754 — sound TS settings for `.ts`/`.js` + codegen defensive-correctness
  (the band-aid layer this complements).
- #2755 — decide the type-soundness approach (trust-the-type vs JS-semantics-first).
