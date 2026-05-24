---
id: 1612
title: "parser: top-level-await with array-literal operand misparsed as element access ('should take an argument')"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
task_type: bug
area: parser
language_feature: top-level-await, array-literals
es_edition: es2022
goal: compiler-correctness
test262_count: 14
---

# #1612 — TLA + array-literal operand misparsed as element access

## Problem

14 test262 tests fail with:

```
An element access expression should take an argument.
```

All are `language/module-code/top-level-await/syntax/*-array-literal` tests:
`await [x]`, `if (await [x])`, `void await [x]`, `export let y = await [x]`,
etc. The parser treats the `[...]` array literal following `await` as a
**member/element-access bracket** on the awaited value rather than a fresh
ArrayLiteral expression, then errors because the bracket is "empty" or
malformed for element access.

## Failing test examples

- `test/language/module-code/top-level-await/syntax/for-await-expr-array-literal.js`
- `test/language/module-code/top-level-await/syntax/if-expr-await-expr-array-literal.js`
- `test/language/module-code/top-level-await/syntax/void-await-expr-array-literal.js`

## Root-cause hypothesis

After parsing the `await` UnaryExpression operand, the parser's postfix loop
greedily consumes a following `[` as an element-access on the await result.
Per grammar, `await ArrayLiteral` should parse the `[...]` as the operand's
primary expression. Fix the precedence so `await` binds its UnaryExpression
operand (including a leading array literal) before postfix member access is
considered.

## Acceptance criteria

- `await [ ... ]` in module top-level code parses correctly.
- >=10 of the 14 tests move off `compile_error`.
