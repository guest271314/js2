---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.

## Full root-cause + WIP status (2026-06-15, sdev5)

Repro confirmed on main `39a63edf0` (both wasm + standalone CompileError
`call[0] expected (ref null 6), found f64`). The defect is a **shared flat
funcMap namespace**: a class member `A.m` registers funcMap key `A_m`; the
user-function reservation (`ensureSiblingFunctionsRegistered`,
declarations.ts:3660) then **silently skips** `function A_m()` because
`funcMap.has("A_m")` is already true, so `A_m()` call sites resolve to the
class method's funcIdx (wrong signature → trap).

### The collision spans FOUR distinct name-spaces, not one

Pinned by exhaustive tracing. Any fix must keep all four consistent:

1. **`ctx.funcMap` funcIdx key** — `${className}_${member}` (the trap source).
2. **wasm display name** (`mod.functions[i].name`) — because the body-fill
   `funcByName` map (compileDeclarations) is built from display names; a
   collision there mis-fills bodies.
3. **`funcByName` body-fill lookups** in class-bodies.ts (ctor/init/method/
   getter/setter) AND the struct-method pre-registration in `ensureStructForType`
   (index.ts:10120) — three separate reservation sites.
4. **The DCE finalize funcIdx remap** (`dead-elimination.ts` Phase 4) — see
   "Remaining" below.

### Approach implemented (branch `issue-1983-funcmap-key`, commit 26f099222)

`classMemberFuncKey(ctx, fullName)` (new leaf module `class-member-keys.ts`):
returns the **byte-identical** legacy key for every non-colliding program, and
only on a real collision relocates the *class member's* funcMap key + display
name to `__cm$<name>` (a prefix no `${className}_${member}` join can emit). The
user function keeps the bare `A_m` key (it is no longer skipped, because the
class member vacated `A_m`), so its many bare-call / export / ref.func consumers
are untouched. `topLevelFunctionNames` is pre-scanned at `generateModule` start
(MUST precede all class registration — producers query it).

Routed through: producers (class-bodies.ts ctor/init/method/getter/setter +
inheritance copy; index.ts `ensureStructForType`; new-super.ts ctor) and the
class-method-dispatch consumers (calls.ts main + static + inheritance/override
scans; new-super.ts; closures.ts). Membership sets (`classMethodSet` etc.) and
per-name metadata (`funcOptionalParams`/`funcRestParams`/`funcUsesArguments`)
intentionally stay on legacy `fullName` (they answer "is this a class member",
collision-free; method-dispatch reads them by the same legacy name).

### Verified correct so far

- Typechecks clean. Both function **bodies** are now emitted correctly:
  `$__cm$A_m` = `(param (ref null 6))(result f64)` body `f64.const 10` (method,
  takes self); `$A_m` = `()→f64` body `f64.const 2` (user fn). They are now
  **separate** functions (was a single clobbered slot).
- The dispatch site **bakes the right compile-time funcIdx** (instrumented:
  `new A().m()` bakes `call <method funcIdx>`, fnName=`__cm$A_m`).

### REMAINING (blocks acceptance — needs dedicated sequencing)

`test()` still returns `4` not `12`: in a function that calls BOTH `new A().m()`
and `A_m()`, the **DCE finalize funcIdx remap** (`dead-elimination.ts` Phase 4
`fR` table) mis-maps the relocated method's compile-time index — the
`new A().m()` `call` lands on the user fn's *final* slot (idx 5) instead of the
method's (idx 4), even though the pre-DCE baked index and both bodies are
correct. The remap/reachability needs to be relocation-aware (order-dependent).

This touches the funcIdx **reservation + DCE remap pipeline** — the compiler's
highest-regression-risk machinery — and is order-dependent. Recommend it land as
a **dedicated change with architect input on the reservation pipeline, NOT raced
against the active #2158** (which edits class-bodies.ts concurrently). The
branch + commit 26f099222 carry the complete scaffolding; resume by making the
DCE Phase-4 remap consistent with the relocated keys (and re-run the equivalence
+ class suites — the safe-by-construction property means a green suite proves the
non-colliding path is unchanged).
