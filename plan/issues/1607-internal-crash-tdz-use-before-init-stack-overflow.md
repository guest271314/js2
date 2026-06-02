---
id: 1607
title: "codegen crash: 'Maximum call stack size exceeded' on use-before-initialization (TDZ) in declaration statements"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: tdz-lexical-bindings
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 8
---
# #1607 — Compiler stack overflow on use-before-initialization declarations

## Problem

8 test262 tests crash the compiler:

```
Maximum call stack size exceeded
```

All 8 are use-before-initialization-in-declaration tests for `const`,
`let`-style bindings, and `await using`:

- `test/language/statements/const/block-local-use-before-initialization-in-declaration-statement.js`
- `test/language/statements/await-using/block-local-use-before-initialization-in-declaration-statement.js`
- `test/language/statements/await-using/global-use-before-initialization-in-declaration-statement.js`

The declaration's initializer references the binding being declared (e.g.
`const x = x;` / `await using x = x;`), and the compiler's type/value
resolution recurses on the self-referential binding without a cycle guard,
blowing the JS call stack.

## Root-cause hypothesis

Binding type-resolution or initializer codegen in `src/codegen/statements.ts`
follows the declaration's symbol back to itself when the initializer names the
declared identifier (a TDZ / self-reference case). There is no
visited-set / recursion-depth guard. The spec behaviour is a `ReferenceError`
at runtime (TDZ); the compiler should detect the self-reference and emit the
TDZ throw rather than recursing. Add a cycle guard in the resolution path and
emit the TDZ `ReferenceError` for self-referential lexical initializers.

## Acceptance criteria

- The three example tests compile without a stack-overflow crash.
- All 8 tests move off `compile_error` (ideally to pass with a TDZ
  `ReferenceError`).

## Resolution

Root cause: `tryStaticToNumber` in `src/codegen/expressions/misc.ts` traces an
identifier back to its `const`/`using`/`await using` declaration initializer
(line ~450) to fold constants. For a self-referential lexical initializer
(`const x = x;`, `await using x = x + 1;`) the initializer names the very
binding it declares, so the trace re-enters the same declaration node forever,
overflowing the JS call stack during codegen. The crash only surfaced under the
test262 path because that uses `skipSemanticDiagnostics: true`, which suppresses
the TS pre-check that otherwise short-circuits these forms.

Fix: add a `visitedDecls: Set<ts.Node>` cycle guard threaded through the
recursive calls. Before tracing through a declaration we check whether it is
already on the current path; if so we return `undefined` (bail to runtime),
which lets the normal codegen path emit the spec-required TDZ `ReferenceError`
instead of recursing. Non-cyclic constant folding is unaffected.

Regression test: `tests/issue-1607.test.ts` (8 self-referential cases compile
without an internal/stack-overflow error; one non-cyclic fold still succeeds).
