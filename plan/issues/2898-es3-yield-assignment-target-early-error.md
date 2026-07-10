---
id: 2898
title: "≤ES3: `yield` as assignment target should be an early SyntaxError (currently compiles)"
status: done
completed: 2026-06-30
priority: high
sprint: 69
created: 2026-06-30
feasibility: medium
task_type: bug
area: codegen
es_edition: 3
language_feature: early-error
goal: spec-completeness
related: [2897]
---

# #2898 — `yield`-expression as assignment target is missing its early SyntaxError

One of the **8 tests blocking 100% ≤ES3 conformance**.

## Failing test

`test/language/expressions/assignmenttargettype/direct-yieldexpression-0.js`

→ **`expected parse/early SyntaxError but compiled and instantiated successfully`** — we accept a program the spec rejects at parse time.

## What it checks

A `YieldExpression` has AssignmentTargetType "invalid", so using it as an assignment target is an **early SyntaxError** (negative test, `phase: parse`). We currently compile + instantiate it instead of rejecting it.

## Root-cause direction

Early-error / negative-test handling: the parser or the pre-codegen early-error pass does not flag a `yield`-expression in assignment-target position. Find where AssignmentTargetType invalidity is (or isn't) enforced — the negative `phase: parse` test expects a `SyntaxError` raised before compilation. Note this is an **edition-heuristic ≤ES3 bucket** (yield is ES6); it counts toward the project's ES3 metric but is an early-error/generator concern.

## Acceptance

- The test raises the expected early `SyntaxError` and is recorded as pass.
- No regression in valid `yield`/generator tests.

## Resolution (2026-06-30)

**Root cause.** TypeScript parses the top-level `yield x = 1;` as a single
`YieldExpression` whose operand is `x = 1` (i.e. `yield (x = 1)`), not as
`(yield x) = 1`. Outside a generator, `yield` is not a yield expression at all —
in sloppy code it is an `Identifier` — so TS leniently consuming an operand here
is exactly the parse error the spec demands. The early-error pass
(`detectEarlyErrors`) had no rule for a `YieldExpression` outside a generator, so
it compiled through (the negative test only "passed" incidentally via the
runner's warning→pass heuristic + the `$DONOTEVALUATE` undefined-name warning —
fragile and not a real rejection).

**Fix.** `src/compiler/early-errors/node-checks.ts` — in the `YieldExpression`
branch, after the existing generator-params check, flag a `YieldExpression` that
is **not inside any function** as an early SyntaxError. This is the _sound_
invariant (yield is only valid inside a generator, which is a function), so it
has **zero false positives**: a `[yield]`/`[yield 9]` `ComputedPropertyName` on a
non-generator method _inside_ a generator (evaluated in the enclosing generator
scope — test262 `name-prop-name-yield-expr`, `cpn-class-*-from-yield-expression`)
sits under a `MethodDeclaration`, so `isInsideFunction` is true and it is left
untouched. The broader in-function generator-context cases are out of scope.

**Validation.**

- `tests/issue-2898.test.ts` (14 unit cases) — rejects `yield x = 1;` / `yield 1;`
  at the top level; accepts every valid generator yield form + the computed
  property-name-in-generator regression guards + sloppy `yield`-as-identifier.
- Real test262 runner verdict `pass` for `direct-yieldexpression-0/1`,
  `parenthesized-yieldexpression-0/1`.
- AST scan of all 23,629 `language/` test262 files: **0** positive tests carry a
  top-level (outside-any-function) `YieldExpression` → no over-rejection.
- Valid generators still compile + run (`for-of` over a generator).
