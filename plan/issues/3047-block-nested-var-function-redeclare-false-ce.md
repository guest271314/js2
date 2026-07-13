---
id: 3047
title: "false CE — `var x; function x(){}` same-name coexistence inside a block wrongly rejected as 'Cannot redeclare block-scoped variable' (#1389 residual)"
status: done
assignee: ttraenkler/dev-3047
completed: 2026-07-05
sprint: 71
priority: high
horizon: m
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: codegen
language_feature: hoisting, block-scope, var-function-coexistence
goal: spec-completeness
test262_category: language/block-scope, language/expressions/dynamic-import
related: [1389]
---

# #3047 — block-nested `var` + function-declaration same-name → false "Cannot redeclare" CE

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02 promoted baseline). **31**
`compile_error` files with the exact message
`Cannot redeclare block-scoped variable 'X'` (excluding the ~21 that also carry
the unrelated `import.source(...)` Stage-proposal error).

## Root cause (reproduced on current main, dev-3025)

`#1389` fixed the same-name `var` + function-declaration coexistence at
**top-level** (sloppy mode legally allows `var f; function f(){}` — both bind the
same name). But the fix does NOT cover the **block-nested** case:

```ts
// top-level — OK (fixed by #1389):
var smoosh; function smoosh() {} smoosh();            // compiles

// inside a block — STILL a false CE:
if (true) { var smoosh; function smoosh() {} }
// => CE: Cannot redeclare block-scoped variable 'smoosh'
```

A `var` hoists to the function/global scope while a block-level function
declaration (Annex B sloppy semantics) also binds — they legally coexist; the
compiler's block-scope redeclaration check wrongly treats the pair as a
lexical (let/const-style) re-declaration and rejects it.

## Sample failing files (31 total; see jsonl for the full set)

- `language/block-scope/syntax/redeclaration-global/allowed-to-redeclare-function-declaration-with-var.js`
- `language/block-scope/syntax/redeclaration-global/allowed-to-redeclare-var-with-function-declaration.js`
- `annexB/language/function-code/function-redeclaration-switch.js`
- `built-ins/RegExp/prototype/exec/S15.10.6.2_A1_T9.js`
- `language/expressions/dynamic-import/syntax/valid/nested-async-function-script-code-valid.js` (many dynamic-import/syntax/valid twins — the redeclare CE is the primary/blocking error there)

## Suggested approach

Find the block-scope redeclaration diagnostic (grep `Cannot redeclare
block-scoped variable`) and relax it to allow a `var`-declared name to coexist
with a same-name **function declaration** (and vice-versa) in sloppy mode,
mirroring whatever exemption #1389 added for the top-level scope — extend it to
nested block scopes. Keep rejecting genuine `let`/`const`/class re-declarations.

## Acceptance criteria

- `if (true) { var x; function x(){} }` and the two
  `language/block-scope/syntax/redeclaration-global/*` files compile.
- No new false-negatives: real lexical re-declaration (`let x; let x;`,
  `let x; function x(){}` in a block) still errors.
- No test262 regression.

## Resolution (dev-3047, 2026-07-05)

The harvest's hypothesis (a *block-nested* redeclaration bug, and that
`if (true) { var x; function x(){} }` should compile) was **partly incorrect**.
Verified against V8/Node:

- `var f; function f(){}` at **Script / function-body top level** → **legal**
  (a FunctionDeclaration is VAR-scoped there — `TopLevelLexicallyDeclaredNames`
  excludes HoistableDeclarations).
- `{ var f; function f(){} }` in a **genuine nested Block** (incl. `if`/`for`/
  `try` blocks) → **SyntaxError in BOTH strict and sloppy mode**. Annex B relaxes
  only the *duplicate-FunctionDeclaration* rule (B.3.3.5), never lexical-vs-var.
  test262 carries **negative** parse tests for exactly this
  (`language/block-scope/syntax/redeclaration/var-name-redeclaration-attempt-with-function.js`
  et al.), so it must keep erroring.

**True root cause of the ~50 harvested false CEs:** the test262 harness
(`wrapTest`) places every test body inside `try { ... }`. A `try` block is a
genuine nested Block, so a legal top-level `var f; function f(){}` becomes
`try { var f; function f(){} }` — a real SyntaxError. Two complementary fixes:

1. **Compiler** (`src/compiler/early-errors/duplicates.ts`,
   `checkVarLexicalConflicts`): a FunctionDeclaration is treated as lexical
   (var-conflicting) only inside a *genuine nested Block statement* — not at
   SourceFile scope nor at a **function-body** top level (new
   `isFunctionBodyBlock` predicate). Genuine nested-block cases still error.

2. **Harness** (`tests/test262-runner.ts`, `wrapTest`): when a body's top-level
   statements bind the same name as both a `var` and a `function`, hoist that
   function declaration out of the `try` to the `test()` body top level
   (functions hoist → runtime byte-preserved). Guarded strictly to the
   coexistence pattern (byte-identical for every other test); equal-line padding
   preserves error-line citations.

**Recovers 50/52** harvested `Cannot redeclare block-scoped variable` files. The
2 remaining are distinct root causes (out of scope, follow-ups):
`language/statements/let/syntax/escaped-let.js` (escaped-`let` keyword parse) and
`annexB/language/function-code/function-redeclaration-switch.js` (duplicate
functions across switch clauses, blocked by a TS `Duplicate function
implementation` checker diagnostic, not our early-error).

Tests: `tests/issue-3047.test.ts` (12 cases — both fixes + nested-block
regression guards). All acceptance-criteria negative cases (`let x; let x;`,
`let x; function x(){}` in a block) still error.
