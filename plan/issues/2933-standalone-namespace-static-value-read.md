---
id: 2933
title: "Standalone: Math/JSON/Reflect/Atomics namespace static VALUE reads refuse — fold constants / native static-method closures"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: medium
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2861, 1907, 1888]
umbrella: 2860
---

# Standalone: namespace static VALUE reads refuse

## Problem

Split-out follow-up from #2861 (which the Implementation Plan explicitly deferred
here). In `--target standalone`, reading a **namespace** builtin's static member
as a first-class VALUE (not calling it) refuses with the `#1907`/`#1888 S6-b`
"built-in static property value read is not supported" compile error:

```
Codegen error: JSON.stringify built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

`Math`, `JSON`, `Reflect`, `Atomics` are **namespaces**, not constructors — the
read is `Math.LN2` (a static data prop) or `JSON.stringify` (a static method as a
value), NOT `Math.prototype.x`. They do NOT go through the `$NativeProto`
proto-glue that #2861 wired for the real ctors, and their `.length`/`.name` are
`undefined` (so #2861's `BUILTIN_CTOR_ARITY` fold deliberately excludes them).

## Scope (measured against current main, 2026-07-02)

Already working on current main (do NOT re-do):

- Namespace static **data constants** with a statically-known name — `Math.PI`,
  `Math.E`, `Math.LN2`, `Number.MAX_SAFE_INTEGER`, `Symbol.iterator` — already
  fold to `f64.const` / `i32.const` (`hasNativeBuiltinConstantHandler` +
  downstream emitter in `property-access.ts`).
- Static-method **calls** — `Math.max(...)`, `JSON.stringify(...)`,
  `Reflect.ownKeys(...)`, `Atomics.add(...)` — compile via the call path.

Still refusing / wrong (this issue):

1. **Static-method VALUE reads** — `const f = JSON.stringify; f(o)`,
   `const g = Math.max; g(1,2)`, `Reflect.get` / `Atomics.add` as a value. These
   hit the `reportUnsupportedStandaloneBuiltinValueRead` refusal. Fix: emit a
   native static-method closure (reuse the `ensureStandaloneBuiltinStaticMethodClosure`
   factory / the #2175 `"static"` path, `property-access.ts`).
2. **Reflective `namespace[computedKey]`** — `const k = "PI"; Math[k]` currently
   reads back `0` (wrong value, not a CE); `Reflect.ownKeys(o).length` reads back
   `0`. Distinct correctness bug — route the reflective read to the folded
   constant / native method.
3. **`globalThis.Math.PI`** currently TRAPs (niche).

## Acceptance criteria

- [ ] `const f: any = JSON.stringify; f({a:1})` works in standalone (returns the
      JSON string), zero host imports.
- [ ] `const g: any = Math.max; g(1,2,3) === 3` in standalone.
- [x] `Math["PI"]` (reflective, `any`-typed key) reads π, not 0. — landed
      2026-07-02, see Progress.
- [x] No host-mode regression (`ctx.standalone`-gated). — the reflective fold is
      observationally identical in host mode.

## Progress (2026-07-02, opus-12c) — reflective namespace-constant read landed

Sub-part 2 (reflective `namespace[computedKey]`) is fixed for the `Math`/`Number`
**numeric constants**. A statically-resolvable computed key on `Math`/`Number`
(`Math["PI"]`, `(Math as any)["PI"]`, `const k = "PI"; Math[k]`,
`Number["MAX_SAFE_INTEGER"]`, …) now folds to the SAME `f64.const` the syntactic
dot read (`Math.PI`) emits — via a new `tryEmitBuiltinNamespaceConstantValue`
helper (single source of truth: `MATH_CONSTANT_VALUES` / `NUMBER_CONSTANT_VALUES`)
called from an early branch in `compileElementAccess` (`src/codegen/property-access.ts`).
Standalone previously returned `0`; host mode round-tripped `__extern_get`
(same value) — the fold is host-observationally identical and the only host-free
lowering for the computed form. Non-constant keys (`Math[i]`) and non-constant
members (`Math["max"]`) fall through unchanged. Covered by `tests/issue-2933.test.ts`
(9 cases incl. regression guards).

**Remaining (this issue stays open):**

1. Static-method VALUE reads (`const f = JSON.stringify; f(o)`,
   `Reflect.ownKeys` as a value) — needs the `ensureStandaloneBuiltinStaticMethodClosure`
   value-closure wiring. `JSON.stringify` carries a native-`$AnyString`-return →
   externref coercion at the any-call boundary + a 7-arg `__json_stringify_value`
   call, so it is not a one-line switch add; scope carefully.
2. `Math.max` / `Math.min` **as a value** (`const g = Math.max; g(1,2,3)`) is
   genuinely VARIADIC — value-closures are fixed-arity, so it needs
   variadic-closure support. Recommended to split into its own follow-up.
3. `Reflect.ownKeys(o).length` reflective-read-of-result and `globalThis.Math.PI`
   (niche trap) also remain.

## Notes

Umbrella #2860. Follows #2861 (ctor/prototype value reads + `<Ctor>.length`/
`.name`, done). ~120 of the original 882-test `#2861` cluster live here.
