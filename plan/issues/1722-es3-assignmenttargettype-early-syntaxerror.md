---
id: 1722
title: "ES3: AssignmentTargetType early SyntaxError not raised (parenthesized object/array literal as assignment target)"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: low
feasibility: medium
task_type: bugfix
area: parser
language_feature: assignment-target-type-early-error
goal: test262-conformance
sprint: 57
es_edition: 0
test262_fail: 4
test262_category: language/expressions/assignmenttargettype
related: [1091, 402]
---
# #1722 — ES3: AssignmentTargetType static semantics — missing early SyntaxError

## Problem (edition ≤ ES3, negative parse tests)

`language/expressions/assignmenttargettype/*` negative tests (`phase: parse`,
`type: SyntaxError`) compiled + instantiated successfully instead of being
rejected at parse time:

```js
() => ({}) = 1;        // direct-arrowfunction-1
async () => ({}) = 1;  // direct-asyncarrowfunction-1
({}) = 1;              // parenthesized ObjectLiteral as target
```

All reduce to the same defect: a **parenthesized** ObjectLiteral / ArrayLiteral
is treated as a valid destructuring AssignmentPattern target. Per the spec a
CoverParenthesizedExpressionAndArrowParameterList cannot be refined to an
AssignmentPattern, so `({}) = 1` is an early SyntaxError. (Confirmed against
Node: `({}) = 1` and `({a:1}) = 1` throw `SyntaxError: Invalid left-hand side
in assignment`, while `[] = 1` and `({} = 1)` are valid.)

## Root cause (confirmed)

`isInvalidAssignmentTarget` in `src/compiler/validation.ts` unwrapped
parentheses **before** the destructuring check, so a parenthesized object/array
literal reached the `allowDestructuring` branch and was wrongly accepted. The
destructuring forms are only valid when they appear *directly* as the LHS.

## Fix

`src/compiler/validation.ts` — test the destructuring object/array-literal
forms on the **original** (un-unwrapped) node before stripping parens; only
identifiers / property access / element access remain valid through parens
(`(x) = 1` stays valid, `({}) = 1` becomes an error). One-function change.

Spec: [§13.15.1 Static Semantics: Early Errors](https://tc39.es/ecma262/#sec-assignment-operators-static-semantics-early-errors),
[§13.x AssignmentTargetType](https://tc39.es/ecma262/#sec-static-semantics-assignmenttargettype).

## Acceptance criteria

- `direct-arrowfunction-1` / `direct-asyncarrowfunction-1` rejected with a
  parse-phase SyntaxError. ✅
- `({}) = 1`, `({a:1}) = 1`, `() => (1 = 1)` rejected. ✅
- No regression: `[a,b] = x`, `({a} = x)`, `(x) = 1`, chained `a=b=c` still
  accepted (equivalence destructuring + assignment suites 19/19 pass). ✅

## Residual (out of scope)

`yield x = 1;` (`direct-yieldexpression-0`) is a separate gap — `yield` at the
top level of a script is an Identifier and `yield x` is two adjacent
expressions, which TypeScript's parser accepts but Node rejects with
`Unexpected identifier 'x'`. That is a yield-context parse issue, not an
AssignmentTargetType one; not addressed here.

## Test Results

- `tests/issue-1722.test.ts` — 10/10 pass (5 reject cases, 5 accept cases).
- `tests/issue-1611.test.ts` early-error suite — 14/14 (no regression).
- `tests/equivalence/basic-destructuring.test.ts` +
  `assignment-expression-value.test.ts` — 19/19 (no regression).

## Source

Filed by product-owner test262 triage (ES3 / edition-0 view) 2026-05-29 against
main baseline (`.test262-cache/test262-current.jsonl`, 48,117 records).
