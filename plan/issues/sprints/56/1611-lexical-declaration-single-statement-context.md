---
id: 1611
title: "parser: lexical declaration in single-statement context rejected for valid newline-separated cases"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
task_type: bugfix
area: parser
language_feature: lexical-declarations, asi
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 16
---
# #1611 — `let`/`const` in single-statement context: valid newline cases rejected

## Problem

16 test262 tests fail with:

```
Lexical declaration cannot appear in a single-statement context
```

The cluster is the `let-identifier-with-newline` / `let-block-with-newline`
family under `for-in`, `for-of`, and `if`. In these tests `let` appears on its
own line and, per ASI, is parsed as an *identifier reference* followed by a
newline — NOT a lexical declaration — so the program is actually valid. The
compiler eagerly classifies the token as a lexical declaration and rejects it.

## Failing test examples

- `test/language/statements/for-in/let-identifier-with-newline.js`
- `test/language/statements/for-of/let-block-with-newline.js`
- `test/language/statements/if/let-block-with-newline.js`

## Root-cause hypothesis

The parser/early-error check treats `let` as a lexical-declaration keyword in
the body of `for`/`if` without applying the ASI / `let [` disambiguation rules
(ECMA-262: `let` followed by a line terminator and then an identifier is an
ExpressionStatement, not a LexicalDeclaration). Refine the single-statement
lexical-declaration early error to respect the newline-based disambiguation.

## Acceptance criteria

- The newline-separated `let` identifier/block cases compile (or correctly
  pass/fail per the test's `negative` expectation).
- >=12 of the 16 tests move off `compile_error`.
