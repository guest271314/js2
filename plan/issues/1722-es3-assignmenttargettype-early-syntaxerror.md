---
id: 1722
title: "ES3: AssignmentTargetType early SyntaxError not raised (yield / arrow-function as assignment target)"
status: ready
created: 2026-05-29
updated: 2026-05-29
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

Four `language/expressions/assignmenttargettype/*` tests are negative
(`phase: parse`, `type: SyntaxError`) and we **compile + instantiate them
successfully** instead of rejecting at parse time:

```
expected parse/early SyntaxError but compiled and instantiated successfully
```

The constructs assert that certain productions have AssignmentTargetType
"invalid" and therefore cannot be the target of an assignment:

```js
yield x = 1;                        // direct-yieldexpression-0
() => {} = 1;  /* arrow */          // direct-arrowfunction-1
async () => {} = 1;                 // direct-asyncarrowfunction-1
```

#1091 and #402 (both `done`) improved early-error detection broadly but did not
cover these AssignmentTargetType cases.

## Root-cause hypothesis

The parser/early-error pass does not consult Static Semantics:
AssignmentTargetType (§13.x) before accepting an `AssignmentExpression` whose
LHS is a `YieldExpression`, `ArrowFunction`, or `AsyncArrowFunction` — all of
which are `invalid` targets and must produce a SyntaxError at parse time.

Spec: [§13.15.1 Static Semantics: AssignmentTargetType / Early Errors](https://tc39.es/ecma262/#sec-assignment-operators-static-semantics-early-errors),
[§13.x AssignmentTargetType](https://tc39.es/ecma262/#sec-static-semantics-assignmenttargettype).

## Example failing tests

- `test/language/expressions/assignmenttargettype/direct-yieldexpression-0.js`
- `test/language/expressions/assignmenttargettype/direct-arrowfunction-1.js`
- `test/language/expressions/assignmenttargettype/direct-asyncarrowfunction-1.js`

## Acceptance criteria

- The three example negative tests are rejected with a parse-phase SyntaxError
  (they now count as `pass`).
- No regression in #1091 / #402 early-error tests.

## Notes

Low value (4 tests) but a crisp, edition-0-scoped early-error gap; bundled into
the Sprint 57 ES3 conformance track.

## Source

Filed by product-owner test262 triage (ES3 / edition-0 view) 2026-05-29 against
main baseline (`.test262-cache/test262-current.jsonl`, 48,117 records).
