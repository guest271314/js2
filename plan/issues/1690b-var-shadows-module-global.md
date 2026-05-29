---
id: 1690b
title: "Inner function `var x` aliases module-level `__mod_x` global instead of allocating a function-local"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, identifier-resolution, scoping
language_feature: var-hoisting, function-scope, shadowing
goal: self-hosting-dogfood
sprint: Backlog
parent: 1690
related: [1690, 1710, 1711, 1712]
note: "Carved from #1690 — root-cause work on the acorn.mjs stress test surfaced two distinct defects. Defect #1 (this issue) is a runtime-semantics scoping bug independent of the f64/array-ref Wasm-validation issue tracked under #1690 itself."
---
# #1690b — Inner `var x` aliases module-level `__mod_x` global (identifier-resolution layer)

## Problem

A `var` declaration inside a function body is **not** allocated as a function
local when the same name already exists as a module-level global. All reads and
writes of the inner `x` then alias the module global instead of the
function-scoped binding, violating ECMA-262 §10.2.10 (function-scoped `var`
hoists to the *enclosing function*, not to the module).

### Minimal repro

```ts
var i = 999;
function f() {
  var i = 7;
  i = i + 1;
}
export function test(): number {
  f();
  return i;     // expected 999, actual 8
}
```

Spec: `f()` allocates its own `var i`, mutates it from 7 → 8, and returns. The
module-level `i` must remain `999`. Today's compiler emits `8`, proving the
inner write landed on the module global.

This pattern is everywhere in real-world JS — acorn.mjs hits it in
`isInAstralSet` and several scanner helpers — so the bug silently corrupts
program state in any module that re-uses common identifier names (`i`, `j`,
`pos`, `ch`, `code`, ...) at the top level.

## Root cause

`hoistVarDecl` and `hoistBindingPattern` in `src/codegen/index.ts` both
short-circuit allocation when the name collides with a module global:

```ts
// src/codegen/index.ts:9436-9440
function hoistVarDecl(ctx, fctx, decl) {
  if (ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    if (fctx.localMap.has(name)) return;
    if (ctx.moduleGlobals.has(name)) return;   // ← skips local allocation
    ...
  }
}

// src/codegen/index.ts:9363-9382
function hoistBindingPattern(ctx, fctx, pattern) {
  ...
  if (fctx.localMap.has(name)) continue;
  if (ctx.moduleGlobals.has(name)) continue;   // ← same skip
  ...
}
```

`ensureLetConstBindingPatternTdzFlags` at `src/codegen/index.ts:9402-9432`
contains the same skip.

With the local never allocated, the identifier resolver in
`src/codegen/expressions/identifiers.ts` falls through `localMap` to the
`moduleGlobals` branch (lines 491-511) and emits `global.get/global.set
$__mod_i` for **every** read/write of `i` inside the function body. This is
the correct fallback when the inner function genuinely refers to the module
global (no inner `var`), but it is wrong when there *is* an inner `var i`.

Note: `walkModuleStmtForVars` (`src/codegen/declarations.ts:2873`) does the
module-level var-hoisting walk correctly — it only descends into top-level
control-flow constructs (`if`, `for`, `try`, `switch`, …), not into function
bodies. So the module-level set of vars is right; the bug is downstream, in
the per-function hoister that suppresses the inner allocation.

## Fix approach

Per-function `var` declarations must always allocate a function-local; the
function-local must shadow the module global inside the function body.

1. **Remove the `moduleGlobals.has(name)` short-circuit from the three
   function-body var hoisters in `src/codegen/index.ts`:**
   - `hoistVarDecl` (line 9440)
   - `hoistBindingPattern` (line 9369)
   - `ensureLetConstBindingPatternTdzFlags` (line 9411)

   These functions only run while compiling a function body, so unconditionally
   allocating the local is correct: a `var x` declared *anywhere* inside a
   function (per JS hoisting) must become a function-local regardless of any
   module-level binding with the same name.

2. **Verify the identifier resolver order still does the right thing.** In
   `src/codegen/expressions/identifiers.ts`, the lookup order is
   `localMap` → `capturedGlobals` → `moduleGlobals`. Once step 1 puts the inner
   `var i` into `fctx.localMap`, both reads and writes inside `f()` resolve to
   the function-local automatically; the module global is only reached when no
   shadow exists. No edits required here — but confirm with the repro tests.

3. **Audit the remaining `moduleGlobals.has(name)` guards** in
   `src/codegen/declarations.ts` (lines 2799, 3023, 3040, 3332),
   `src/codegen/closures.ts` (lines 301, 2264), and
   `src/codegen/expressions/assignment.ts` (lines 362, 650-673). Most of these
   gate the **module-level** registration walk and remain correct (they prevent
   double-registering a module global). The assignment-side guards
   (`assignment.ts:362` and the destructuring-assignment guards 650-673) need
   careful review: they currently treat a bare `name = value` as a module-global
   write when the name is in `moduleGlobals`, which collides with the new
   function-local. The fix is to check `fctx.localMap.has(name)` *first* in
   those guards (most already do, but verify all four).

4. **Closure capture of the module global.** If an inner function references
   the *outer* module global by reading the same name without an inner `var`,
   the existing capturedGlobals path still works — capturing happens by name in
   `closures.ts:301` (the `moduleGlobals.has(name)` check there filters captures
   *to* the module global, which is still correct).

## Tests

Add `tests/issue-1690b-var-shadows-module-global.test.ts` with these cases:

1. **Basic shadow** (repro above): `var i` at module + `var i` in function;
   function mutates inner; module's `i` must be unchanged.
2. **Function-local var without initializer** must read as `undefined`
   (not the module value):
   ```ts
   var x = 42;
   export function test(): unknown {
     var x;
     return x;   // expected undefined
   }
   ```
3. **Hoisted var inside nested block** (`if`/`for`/`try`) inside a function:
   ```ts
   var n = 1;
   function g() {
     if (true) { var n = 5; }
     return n;
   }
   export function test(): number { return g(); }  // expected 5
   ```
4. **Module global still accessible from a function that does NOT declare a
   shadow**: regression-guard for the captured-globals path.
   ```ts
   var k = 11;
   function h() { return k; }
   export function test(): number { return h(); }  // expected 11
   ```
5. **Destructuring shadow**:
   ```ts
   var p = "outer";
   function d() { var { p } = { p: "inner" }; return p; }
   export function test(): string { return d(); }  // expected "inner"
   ```

Each case compiles to Wasm + executes — no host-import dependency.

## Test262 expected impact

Hard to estimate precisely without running the suite, but acorn.mjs alone
hits this pattern dozens of times, and the pattern is common in conformance
tests. Conservative guess: +20 to +60 net pass once landed. Re-run
`test:262 --recheck` after merge to measure.

## Acceptance criteria

1. The five tests in `tests/issue-1690b-var-shadows-module-global.test.ts`
   pass.
2. No equivalence test regresses (`pnpm test -- tests/equivalence.test.ts`).
3. acorn.mjs's `isInAstralSet` (and the other affected scanner helpers) no
   longer alias the module global; per-function `var i` is observably
   function-local in a Wasm-execution probe.
4. Net test262 delta ≥ 0 (this is a correctness fix, not a feature add — any
   loss is a real regression and must be investigated).

## Files to modify (summary)

- `src/codegen/index.ts` — remove the `moduleGlobals.has(name)` skip in
  `hoistVarDecl` (line 9440), `hoistBindingPattern` (line 9369), and
  `ensureLetConstBindingPatternTdzFlags` (line 9411).
- `src/codegen/expressions/assignment.ts` — audit lines 362, 650-673 and
  ensure `fctx.localMap.has(name)` is checked before any module-global write
  path. Add the check where missing.
- `tests/issue-1690b-var-shadows-module-global.test.ts` — new test file with
  the five cases above.

## Out of scope

- The acorn.mjs `f64.lt` reads-array-ref Wasm-validation bug — tracked under
  the parent issue **#1690**. That defect involves global-typed array refs
  participating in number arithmetic and is orthogonal to the scoping fix
  here.
- `let` / `const` inside a function: these already use block-scoped allocation
  via a different path and are not affected by the var-hoister short-circuit.
  Add a regression test only if a residual is observed.

## Test Results (2026-05-28)

Fix implemented across three files:

- **`src/codegen/index.ts`** — removed the `moduleGlobals.has(name)` skip from
  `hoistVarDecl`, `hoistBindingPattern`, and `ensureLetConstBindingPatternTdzFlags`.
  These hoisters only run for nested function bodies, so a `var`/destructuring
  binding inside a function now unconditionally allocates a function-local that
  shadows any module global of the same name.
- **`src/codegen/statements/variables.ts`** — `compileVariableStatement` now
  suppresses the module-global store path (`global.set $__mod_<name>`) whenever a
  function-local shadow already exists in `localMap`, so the inner declaration's
  initializer binds to the local, not the global.
- **`src/codegen/statements/destructuring.ts`** — `syncDestructuredLocalsToGlobals`
  now skips the local→global writeback for any binding pattern declared inside a
  function body (`isModuleLevelBindingPattern` gate), preventing inner destructured
  vars from corrupting the module binding.

Assignment-side audit (`src/codegen/expressions/assignment.ts`): the simple
`x = value` path checks `localMap.get(name)` first (line 119) before the
module-global branch (line 249), and `isUnresolvableIdent` (line 359) and the
destructuring-assignment guards (lines 650–673) all check `localMap.has(name)`
first. No edits required — the local shadow already takes precedence.

Validation:
- `tests/issue-1690b-var-shadows-module-global.test.ts` — 8/8 pass (basic shadow,
  return shadow, uninitialised → undefined, self-reference → undefined, nested-block
  hoist, no-shadow module-global access, array- and object-destructuring shadow).
- 91/91 pass across the scoping/destructuring equivalence suites
  (`var-hoisting-scope`, `basic-destructuring`, `destructuring-extended`,
  `destructuring-initializer`, `destructuring-member-targets`,
  `array-rest-destructuring`, `null-destructuring`, `scope-and-error-handling`,
  `global-index-shift-trycatch`, `global-type-checks`,
  `externref-array-destructuring`, `for-of-array-destructuring`).
- The one failure observed in `tests/module-globals.test.ts`
  (`module-level array with push and length` → `immutable global #3 cannot be
  assigned`) pre-exists on `origin/main` (verified in a clean baseline worktree)
  and is unrelated to this fix.
