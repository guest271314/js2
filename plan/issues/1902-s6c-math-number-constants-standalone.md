---
id: 1902
title: "Math/Number constant reads refuse under --target standalone (__get_builtin pre-empts native f64.const) [#1888 S6-c]"
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05
priority: high
feasibility: easy
task_type: bugfix
area: codegen
language_feature: builtin-property-access
goal: standalone-mode
sprint: 61
---
# #1888 S6-c — Math/Number constants reach native f64.const under standalone

## Symptom (sd-s2 S6 recon 2026-06-05)

Under `--target standalone`, reading a Math or Number constant fails to compile:

```ts
export function run(): number { return Math.PI; }            // Codegen error: '__get_builtin' … not supported
export function run(): number { return Number.MAX_SAFE_INTEGER; } // same
export function run(): number { return Math.PI * 2; }        // same
```

`Math.abs(-5)` (a method **call**) works — that's a separate call-site path. Only
the `Builtin.<constant>` **property-read-as-value** path refuses.

## Root cause

`src/codegen/property-access.ts` has a generic `Builtin.prop` shortcut (the
`BUILTIN_CTOR_NAMES` block, ~line 1478) that calls
`ensureLateImport(ctx, "__get_builtin", …)`. Under standalone, `__get_builtin`
is NOT in `OBJECT_RUNTIME_HELPER_NAMES`, so it hits the
`refuseStandaloneObjectImport` gate and fails-loud. That shortcut sits **above**
the pure-Wasm `f64.const` handlers for Math constants (`PI`/`E`/…, ~line 2299)
and Number constants (`MAX_SAFE_INTEGER`/…, ~line 2317) — so those handlers were
**dead code under standalone**. A program that has a perfectly good native
`f64.const` lowering was turned into a hard compile refusal.

(The earlier S6a recon concluded these were "already native" — that was true for
gc/host, where `__get_builtin` is a real host import that resolves. On the
standalone lane we actually measure, they were broken.)

## Fix (delivered — option: defer to native constant emitter)

`src/codegen/property-access.ts`:
- Added `hasNativeBuiltinConstantHandler(builtinName, propName)` — true for the
  Math/Number f64 constants that have a downstream `f64.const` emitter.
- Gated the `__get_builtin` shortcut: under `ctx.standalone`, when the read is a
  native constant, skip the shortcut so control reaches the `f64.const` handler
  (`const deferToNativeConstant = ctx.standalone && hasNativeBuiltinConstantHandler(...)`).

**Scope:** Math/Number f64 constants only. `Symbol.<wellKnown>` also has a
downstream emitter (an `i32.const` symbol id) but its i32 result does not yet
compose with every consumer under standalone — e.g. `Symbol.iterator !== undefined`
would compare i32 against an externref `undefined` → **invalid Wasm**. Leaving
the shortcut to keep refusing-loud for Symbol is strictly safer (refuse-loud >
silent-wrong); native Symbol value-reads are deferred to **S6-b**.

## Acceptance (all met)

- `Math.PI` → 3.141592653589793, `Math.E + Math.SQRT2`, `Number.MAX_SAFE_INTEGER`,
  `Number.EPSILON`, `Math.PI * 2` all compile + run correctly under standalone,
  module `valid=true`, zero `env::__get_builtin` leak.
- `typeof Math.PI === "number"` still holds (typeof path unaffected).
- gc/host + wasi byte-unchanged (gate is `ctx.standalone`-only; wasi is not
  standalone, so it keeps its existing — separately-tracked — `__get_builtin`
  behavior).
- Guardrail: genuine `Builtin.method` value-reads (Array.isArray, Object.keys,
  JSON.stringify, Reflect.has, String.fromCharCode) still refuse-loud — S6-c
  does NOT widen to non-constant builtin reads (those are the S6-b lever).
- Test: `tests/issue-1888-s6c.test.ts` (7 cases).

## Follow-on

**S6-b** — the real builtins-as-static-globals layer: make `Builtin.staticMethod`
value-reads (and Symbol well-knowns) resolve to native `$Object`/vtable globals
under standalone instead of refusing. S6-c is the constant-only prerequisite
slice that de-risks the reorder and fixes a standalone bug today.

## Owner / lane

sd-s2 — property-access.ts builtin lane. Disjoint from #1901 (literals.ts) — no
merge conflict.
