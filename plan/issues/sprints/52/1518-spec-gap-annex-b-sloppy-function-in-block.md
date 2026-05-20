---
id: 1518
sprint: 52
title: "spec gap: Annex B.3.2 — sloppy-mode function-in-block hoisting (`var` shadow)"
status: in-progress
created: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: annex-b, function-declaration, hoisting
goal: spec-completeness
related: [1435]
---
# #1518 — Annex B function-in-block hoisting

## Problem

`annexB/language/eval-code/{direct,indirect}/` contributes
**~183 failing test262 cases** (133 direct + 50 indirect), plus
~10 in `annexB/language/function-code/` and
~10 in `annexB/language/global-code/`.

The dominant pattern:

```js
// SLOPPY MODE only
if (true) function f() { return 'decl'; }
typeof f;        // expected 'function' (Annex B.3.2)
// our compiler sees only the block-scoped binding → 'undefined'
```

Per ECMA-262 Annex B.3.2, in sloppy mode a `FunctionDeclaration`
inside a `Block`, `IfStatement`, `SwitchStatement`, `TryStatement`,
or `WithStatement` is **hoisted to two places**:

1. The block's lex env (modern semantics, like `let f`).
2. The surrounding function's var env (legacy var-like declaration).

At each evaluation of the block, the lex-env binding is copied into
the var-env binding (so the outer var-binding reflects the latest
function body executed in the block).

## Failure count

**~200 fails**. Realistic target: **~100 flips** — the patterns split
roughly 50/50 between "must hoist" (we don't) and "must update on
each evaluation" (we hoist but don't update).

## Root cause

`src/compiler/parser.ts` + `src/compiler/scope-analysis.ts` (or
equivalent) implement only the modern §13.2.6 / §14.4.3 path:
function declarations inside a block create a `let`-style binding
limited to the block.

The Annex B.3.2 algorithm is:

1. During scope analysis, identify candidate
   `FunctionDeclaration` nodes — those that **are not** in a
   strict-mode context, **are** at top level of a block, and **do
   not** conflict with a lexical binding (`let`/`const`/`class`) at
   the surrounding function scope of the same name.
2. For each candidate, emit a `var`-style binding at the surrounding
   function scope, initially `undefined`.
3. At runtime, when the block evaluates the declaration, write the
   function value to **both** bindings.

The interaction with `eval` (direct eval inside a block) is what
generates the eval-code cluster — Annex B.3.2's hoisting must run
inside the eval source's syntactic scope but write to the *caller's*
function var env, which our eval path does not implement.

## Files to touch

- `src/compiler/parser.ts` — flag function-in-block declarations.
- `src/compiler/scope-analysis.ts` — add Annex B var-bindings for
  candidates.
- `src/codegen/declarations.ts` — emit the dual write on each
  evaluation.
- `src/codegen/eval-shim.ts` (or wherever direct-eval lives) — wire
  the caller's var-env reference through.

## Acceptance criteria

1. ≥ 100 of 200 in `annexB/language/{eval-code,function-code,global-code}/`
   flip to `pass`.
2. Strict-mode tests in `annexB/language/{eval-code,function-code}/`
   still see *no* hoisting (no false positives in `language/statements/let/`).
3. `language/eval-code/direct/lex-env-no-init-cls.js` and friends
   are not regressed.

## Reference tests

- `annexB/language/function-code/if-decl-no-else-func-skip-early-err-for.js`
- `annexB/language/eval-code/direct/func-if-decl-else-decl-b-eval-func-no-skip-param.js`
- `annexB/language/global-code/switch-case-global-skip-early-err-for-in.js`

## Notes

This issue is **explicitly hard**. It is included in the audit
because the test impact is large (~200 tests), but the team may
choose to defer it to sprint 53 if the parser/scope changes risk
churning the working compile path. An alternative: skip-filter the
whole `annexB/language/eval-code/` directory and document the gap.

## Implementation notes (Phase 1 — sprint 52)

**Scope landed.** This PR implements the function-code / global-code
paths (no eval). The `eval-code/` directory is deferred to a follow-up
because direct-eval needs the caller's varEnv plumbing, which our
runtime-eval shim doesn't currently expose.

**Compiler changes** (all under `src/codegen/`):

1. `context/types.ts` — new `FunctionContext.annexBHoistedVars?: Set<string>`.
   Membership signals "this name has been hoisted as an Annex B var binding
   in the current function scope".
2. `statements/nested-declarations.ts` — `hoistFunctionDeclarations` now
   takes a `depth` parameter. At `depth > 0` (recursive entry into a
   block / if / switch / try / loop / labeled-statement), each
   FunctionDeclaration is evaluated as an Annex B candidate:
   - `isStrictModeContext(decl)` short-circuits hoisting in strict code.
   - `hasAnnexBConflict(fctx, ctx, name, decl)` returns true when the
     surrounding function has a clashing parameter, top-level `let`/
     `const`/`class` of the same name, a `for (let|const X)` shadow on
     the path from the decl to its enclosing function, or `name ===
     "arguments"` (covers the `*-skip-early-err-*`, `*-skip-arguments`,
     `*-skip-param.js` patterns).
   - When conflict → we skip the funcMap registration ENTIRELY at this
     depth. The decl reverts to pure block-scope lexical semantics, so
     `typeof f === "undefined"` outside the block now matches spec.
     (Pre-#1518 the funcMap entry leaked out and made `typeof f` const-
     fold to `"function"`.)
   - When no conflict + non-strict → `compileNestedFunctionDeclaration`
     runs (funcMap registration unchanged), then `ensureAnnexBVarBinding`
     allocates an externref local in the surrounding fctx, initialised
     to `__get_undefined()`, and records the name in
     `fctx.annexBHoistedVars`. The allocation happens AFTER the lifted
     compilation so the lifted function's capture analysis doesn't
     mis-classify the outer var slot as a closure capture.
3. `statements.ts` — `compileStatement(FunctionDeclaration)` now emits a
   dual-write at the decl's evaluation site: `emitFuncRefAsClosure` →
   `extern.convert_any` → `local.set` of the var slot. This realises
   step 3.e/f of §B.3.3.1 ("Let fobj be ! benvRec.GetBindingValue(F,
   false); Perform ! fenvRec.SetMutableBinding(F, fobj, false)"). The
   write is guarded by a slot-type check — only externref slots accept
   the coercion safely.
4. `typeof-delete.ts` — `compileTypeofExpression` bypasses the static
   fast-path when the operand identifier is in
   `fctx.annexBHoistedVars`. Otherwise TS would const-fold `typeof f`
   to `"function"` (because TS sees only the FunctionDeclaration
   signature) and break the `f === undefined` initial-state asserts.

**Known limitation: typeof on the assigned value.** Tests that
read `after = f` and then assert `typeof after === "function"` rely
on JS-side `__typeof` recognising the wasm closure struct as a
callable. JS sees the externref-wrapped wasm-GC struct as an opaque
object, so today `typeof after === "object"`. The Wasm-side call
itself works (`after()` dispatches through the externref call_ref
path with `any.convert_extern` + `ref.cast`), so `after() === ...`
asserts pass even when the typeof assert doesn't. Fixing the typeof
side requires the closure-as-JS-function bridge tracked in #1382.
Until then, `*-func-update.js` test262 cases that ALSO check `typeof`
won't flip.

**Test coverage.** New `tests/issue-1518.test.ts` mirrors four of the
core patterns: init (var binding initialised to undefined),
update (post-block value via Wasm call), skip-early-err-for (no
hoist under `for (let f; ;)`), and strict-mode (no Annex B under
`"use strict"`).

**Expected test262 impact.** Conservative: ~50 flips driven by the
init pattern across function-code, global-code, and the skip patterns
that previously fell into `typeof === "function"` false positives.
Pessimistic: regressions on `*-no-init.js` tests where a `var f`
co-exists with `function f(){}` in a block — our dual-write emission
is guarded against non-externref slot types, so it should NOT trap,
but the post-block read would see the pre-existing typed-var value
instead of the function. CI will tell.
