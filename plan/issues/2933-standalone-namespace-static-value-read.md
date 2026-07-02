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
- [ ] `Math["PI"]` (reflective, `any`-typed key) reads π, not 0.
- [ ] No host-mode regression (`ctx.standalone`-gated).

## Notes

Umbrella #2860. Follows #2861 (ctor/prototype value reads + `<Ctor>.length`/
`.name`, done). ~120 of the original 882-test `#2861` cluster live here.
