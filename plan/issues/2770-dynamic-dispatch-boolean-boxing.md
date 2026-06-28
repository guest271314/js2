---
id: 2770
title: "dynamic builtin boolean-method on a bare-var/dynamic receiver boxes the i32 result as a NUMBER not a boolean (set.has/map.has/re.test → 1 not true)"
status: ready
sprint: current
priority: high
created: 2026-06-28
updated: 2026-06-28
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, boolean-boxing
goal: spec-completeness
related: [2767, 2768]
horizon: m
---

# #2770 — dynamic boolean-method result boxes as number, not boolean

A boolean-returning builtin method called on a **bare-`var` / dynamic** receiver
returns a JS **number** (`1`/`0`) instead of a **boolean** (`true`/`false`):

```ts
var s; s = new Set(); s.add(3); s.has(3);   // → 1   (should be true)
var m; m = new Map(); m.set(1,9); m.has(1);  // → 1   (should be true)
var r; r = /a/g; r.test("a");                // → 1   (should be true)
// typed receivers are correct:
const s2 = new Set([3]); s2.has(3);          // → true ✓
```

This is the **type-agnostic** residual the #2767 nominal-recovery approach
chases for booleans — better fixed once in the dynamic dispatch path (no risky
per-type nominal substitution; supersedes #2768 for the boolean cases).

## Root cause (measured via WAT diff)

Typed vs bare-var `s.has(3)` take DIFFERENT extern dispatch paths:

| receiver | host import | result ValType | boxing |
| --- | --- | --- | --- |
| typed `const s = new Set()` | `Set_has` | externref | `__box_boolean` → `true` ✓ |
| bare-var `var s; s = new Set()` | `Map_has` | `{kind:"i32"}` (unbranded) | `f64.convert_i32_s` + `__box_number` → `1` ✗ |

Two coupled defects:
1. **Extern-method boolean returns lose the `boolean: true` brand.** An extern
   class method whose lib.d.ts signature returns `boolean` is registered with
   `results: [resolveWasmType(ctx, retType)]` = `{kind:"i32"}` — the boolean
   brand is dropped (`src/codegen/declarations.ts:1655`, and the
   `registerBuiltinExternClasses` fallback in `src/codegen/index.ts:11878`
   `externMethod`). The unbranded i32 then coerces to f64/number at the
   `any`/return boundary instead of boxing as a JS boolean. The consumption site
   that returns it is `src/codegen/expressions/extern.ts:~150`
   (`return methodInfo.results[0]`).
2. **Bare-var receiver routes to the `Map` extern class (`Map_has`), typed
   routes to `Set` (`Set_has`).** Set is Map-backed, so a dynamic (un-narrowed)
   receiver resolves `className` to the backing struct "Map" and dispatches
   `Map_has` (whose result is the unbranded i32 from defect 1), while a typed
   `Set` receiver dispatches `Set_has` (registered externref in the fallback).
   This is why ONLY the bare-var/dynamic case is wrong.

## Fix direction

Brand boolean-returning extern-method results as `{kind:"i32", boolean:true}` at
the result-construction sites (so the `any`/return coercion boxes them via
`__box_boolean`, not `__box_number`) — for both the lib.d.ts scan and the
`externMethod` fallback. Guard against over-boxing: brand ONLY when the method's
declared return type is `boolean` (not number/other), and do not double-box an
already-externref result.

## Acceptance criteria
- `var s; s = new Set([1]); s.has(1)` → `true` (not `1`); same for `map.has`,
  `set.delete`, `map.delete`, `re.test`, and the ES2025 boolean Set methods
  (`isSubsetOf`/`isSupersetOf`/`isDisjointFrom`).
- Typed-receiver booleans unchanged.
- No over-boxing: number-returning methods (`map.size` accessor, `map.get`,
  `indexOf`, …) stay numbers; already-externref boolean results not double-boxed.
- Full CI / `merge_group` green (the extern method-call path is hot/broad).

## Scope note
Broad-impact (the extern method-call result path is hot). Spans two registration
paths + the className-routing inconsistency, so validate on full CI /
`merge_group`, never a scoped sweep.

## Deeper finding (agent-dev, 2026-06-28) — multi-site, route to architect

Attempted the localized fix (brand the boolean result at the extern-method
registration `collectExternClass`, `index.ts:~12574`) — it did NOT fix the
bare-var case. Reason: the bare-var `s.has(3)` does NOT return via
`methodInfo.results[0]`; it dispatches through one of the
`${className}_${methodName}` funcMap paths (`calls.ts:4606 / 9220 / 9279 /
14077`), each of which returns the result as the **wasm function's return type**
(`getWasmFuncReturnType(...) ?? resolveWasmType(retType)`) = a bare i32, with the
boolean brand dropped at EVERY such site. So the brand is lost in MULTIPLE
dispatch-result paths, not one.

A correct fix needs a **systematic** approach, e.g. a shared
`brandExternMethodResult(ctx, tsReturnType, valType)` helper applied at every
extern-method-result return site (the `${className}_${methodName}` paths +
`extern.ts` + `collectExternClass`), or branding at the return/`any`-coercion
boundary by consulting the call's TS return type. This is broader than a single
box-the-result change → **routing to architect for a spec** (which result sites
to brand, the shared helper signature, over-boxing guards, and the full-CI
validation plan). The precise root cause + the divergent `Set_has`(externref) vs
`Map_has`(i32) routing above give the architect a complete starting point.
