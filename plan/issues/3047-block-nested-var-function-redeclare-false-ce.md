---
id: 3047
title: "false CE — `var x; function x(){}` same-name coexistence inside a block wrongly rejected as 'Cannot redeclare block-scoped variable' (#1389 residual)"
status: ready
sprint: current
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
