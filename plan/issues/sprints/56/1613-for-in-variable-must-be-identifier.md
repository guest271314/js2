---
id: 1613
sprint: 56
title: "codegen: for-in head with binding pattern / non-identifier rejected ('for-in variable must be an identifier')"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: low
feasibility: medium
task_type: bug
area: codegen
language_feature: for-in, destructuring
es_edition: multi
goal: compiler-correctness
test262_count: 10
---

# #1613 — for-in head non-identifier targets rejected

## Problem

10 test262 tests fail at compile time on the for-in head:

```
for-in variable must be an identifier            (7)
for-in requires a variable declaration or identifier (3)
```

These are `language/statements/for-in` scope and bound-name tests where the
for-in head is a `var`/`let` declaration with multiple bound names, a binding
pattern, or a member-expression target rather than a bare identifier.

## Failing test examples

- `test/language/statements/for-in/head-var-bound-names-dup.js`
- `test/language/statements/for-in/scope-body-lex-close.js`
- `test/language/statements/for-in/scope-body-var-none.js`

## Root-cause hypothesis

The for-in statement codegen in `src/codegen/statements.ts` only accepts a
single `Identifier` (or single-declaration) head and throws otherwise. It
should accept the full ForBinding grammar: a binding declaration with its
bound names, a destructuring binding pattern, or an assignment-target
member expression — assigning the enumerated key to the target per iteration.
Extend the head handling to cover these LHS forms.

## Acceptance criteria

- for-in over the declaration/pattern head forms compiles.
- >=7 of the 10 tests move off `compile_error`.
