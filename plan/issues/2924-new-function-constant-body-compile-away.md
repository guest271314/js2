---
id: 2924
title: 'new Function("<const>") compile-away MVP — replace the no-op stub'
status: done
created: 2026-07-02
updated: 2026-07-03
completed: 2026-07-02
assignee: ttraenkler/dev-evalf
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: 69
parent: 1584
depends_on: [2923]
related: [1163, 1584]
---

# #2924 — `new Function("<const>")` compile-away MVP

Slice **B** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-B, §4.4).
Second landable slice — pure AOT, **standalone-safe**, no interpreter.

## Problem

`new Function(...)` / `Function(...)` currently lowers to a **no-op stub**
(`src/codegen/expressions/new-super.ts` ~line 3179): it evaluates the arguments
for side effects and returns `ref.null.extern` — a "function" that returns
`undefined`. Every test that actually _calls_ the constructed function fails
(119 `new Function(` tests fail today, roadmap §5.2), and standalone gets
nothing.

## Key semantic (why this is easier than eval)

Per **§20.2.1.1** `Function(p1, …, pn, body)`, the created function's scope is
**always the global environment** — it never captures the caller's lexical
scope. So there is no environment-reification problem here (that is eval's
Tier-2/§4.1 concern). When the parameter list and body are compile-time
**constant** strings, `new Function("a","b","return a+b")` is semantically
identical to compiling `function (a,b){ return a+b }` at that site.

## Goal

Replace the no-op stub with a compile-away path:

1. Detect the constructor callee is the global `Function` (mirror
   `isGlobalEvalIdentifier` in `eval-tiering.ts` — a `Function` identifier
   resolving only to the `.d.ts` lib declaration, not a local shadow).
2. Resolve each argument with `resolveConstantString` (from `eval-inline.ts`).
   If **all** are constant: the last is the body, the rest are the parameter
   list (comma-split, per §20.2.1.1.1 CreateDynamicFunction).
3. Synthesize `function (<params>) { <body> }` as a foreign SourceFile (reuse
   the #2923-broadened splice machinery) and emit it as a real AOT function
   value (a `funcref`/closure over the **global** scope only).
4. Non-constant arguments keep falling through to the existing path (host import
   today, the Tier-2 interpreter in #2928).

## Edge cases

- **`Function()` no args** → `function anonymous() {}` (empty body). Returns a
  callable that returns `undefined` — but a _real_ callable, not `ref.null`.
- **Multiple param strings** — `new Function("a", "b,c", "return a+b+c")`:
  params flatten across args (`a`, `b`, `c`).
- **Body parse error** → real JS throws `SyntaxError`. Emit the compile-time
  error (matches negative tests) rather than silently returning null.
- **`new` vs plain call** — `Function(...)` and `new Function(...)` are
  equivalent (§20.2.1.1); handle both callee shapes.
- **No lexical capture** — the synthesized function must NOT close over caller
  locals (global scope only). Verify a name used in the body that is a caller
  local resolves as a **global**, not the caller's binding.

## Acceptance criteria

- [x] `new Function("a","b","return a+b")(1,2) === 3` in **standalone** mode.
- [x] `Function("return 42")() === 42` (plain call form) standalone.
- [x] `new Function("a", "b,c", "return a+b+c")(1,2,3) === 6` standalone —
      flatten verified standalone via `return c`; the `a+b+c` composite is
      blocked by the pre-existing chained-any-add gap → **#2948** (exact shape
      passes in host mode; see Done section).
- [x] A body referencing a caller local resolves it as a global (no capture).
- [x] `new Function("return")()` returns `undefined` via a real callable.
- [x] No regression in existing `new Function` tests (scoped suites green; CI
      test262 validates the full corpus).

## Notes

Dynamic-body `new Function` (runtime-computed strings) is deferred to the Tier-2
interpreter (#2928). Umbrella: #1584. Goal: `runtime-eval`.

## Done (dev-evalf, 2026-07-02 — design + partial WIP by dev-eval, session rotated)

Implemented in `src/codegen/expressions/eval-inline.ts`:

- **`synthesizeStaticNewFunction`** — shared synthesis: all-constant args
  (`resolveConstantString`), last = body / rest = comma-joined params
  (§20.2.1.1.1 flatten), parsed as a named foreign function declaration,
  guarded by the #2923 park-fix bails (`"use strict"` prologue → fallback;
  `allNodesInlineSupported`), hoisted over GLOBAL scope with
  `fctx.localMap`/`boxedCaptures` swapped empty (the §20.2.1.1 no-capture
  invariant — capture analysis reads `localMap`, so a caller-local name in the
  body resolves as a global).
- **`tryStaticNewFunction`** (value form) — materializes the callable via
  `emitFuncRefAsClosure` + `extern.convert_any`; wired in `new-super.ts`
  (`new Function(...)`), now guarded by **`isGlobalFunctionIdentifier`**
  (mirror of `isGlobalEvalIdentifier` — a local `Function` shadow keeps the
  legacy stub).
- **`tryStaticFunctionCtorCall`** (early guard in `compileCallExpression`) —
  (1) plain-call value form `Function("...")`; (2) immediate-call form
  `new Function(...)(args)` / `Function(...)(args)` as a DIRECT `call` against
  the synthesized funcIdx, marshalled per the reserved signature via
  `getFuncSignature` (a simple body like `return 42` checker-resolves to f64 —
  never assume externref), missing args padded `undefined`/NaN, extras
  evaluated-and-dropped (§7.3.14). The generic any-callee dispatch does not
  route a NewExpression callee (pre-existing; `(f as any)()` also recurses
  infinitely on main — untouched here).

Acceptance: 1, 2, 4, 5 met exactly; 3 (param flatten) verified with
`new Function("a","b,c","return c")(1,2,3) === 3` standalone and the exact
`a+b+c` shape in HOST mode — the standalone `a+b+c` composite is blocked by the
**pre-existing chained-any-add substrate gap** (an any-add result cannot feed
another any-add; the eval-lift control
`eval("function q(a,b,c){return a+b+c} q(1,2,3)")` fails identically on main)
— filed as **#2948** with repros; re-enable the exact shape there. A `typeof`
on a marshalled boxed-number param misreports too (same #1629b-class layer,
noted in #2948).

Tests: `tests/issue-2924.test.ts` (17 — standalone acceptance, fallback bails,
host-mode flatten + index-shift shapes). No regression in `tests/issue-2923*` /
`eval-tiering` (31 pass). Dynamic bodies and the malformed-body runtime
`SyntaxError` remain on the legacy stub path (Tier-2 #2928).

### Merge-group park fix (PR #2474, 2026-07-02)

First enqueue parked with 4 regressions
(`language/function-code/10.4.3-1-1{3,5}{-s,gs}.js`); diagnosis + prescription
by the parallel session's [CI-FIX] handoff (its dup PR #2464 closed in favor of
#2474). Fixes applied:

1. **`this` bail** — a sloppy dynamic function's bare call must see
   `this === globalThis` (§10.4.3), which the splice cannot provide (free
   function `this = undefined`); any `ThisKeyword` in the synthesized decl
   bails to the legacy path (`containsThisKeyword`).
2. **funcIdx staleness** — arg compiles can `addUnionImports` and shift
   function indices between synthesis and the emitted `call`; the direct-call
   arm now re-fetches the index from `funcMap` after arg marshalling (fixed the
   host 3-arg wrong-value / twice-in-one-expression findings).
3. **Hoist rollback guard** (graft from #2464) — a mid-hoist throw now rolls
   back partially-registered `mod.functions` entries + their `funcMap` keys.

Verification: all 4 parked paths PASS (isolated harness); host 3-arg + twice
shapes PASS; 17 + 31 tests green; Function-dir sweep 3 improvements / 0
attributable regressions (two sweep flips proven false positives — one
reproduces identically on unmodified main, one passes isolated and only fails
under the single-process sweep's shared-realm `Object.prototype` pollution).
