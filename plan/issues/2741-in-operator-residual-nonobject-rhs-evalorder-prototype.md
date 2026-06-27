---
id: 2741
title: "`in` operator residual: non-object RHS TypeError, RHS-reference evaluation order/ReferenceError, prototype-chain membership"
status: ready
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: ES3
language_feature: relational-in
goal: test262-conformance
depends_on: []
---
# #2741 — `prop in obj` relational operator residual

The `RelationalExpression : RelationalExpression in ShiftExpression` operator
(ES2023 §13.10.1) has **~7 fixable `language/expressions/in` fails** on the
current main baseline. (Excludes ES2022 private-field `#x in obj` and
`yield`/`await`-RHS variants — those route to class-fields / generator work, not
this issue.)

## Failing test262 files (current main)

**(a) Non-object RHS must throw `TypeError`** (`If Type(rval) is not Object,
throw a TypeError exception`) — we do not throw for a primitive RHS:
- `test/language/expressions/in/S11.8.7_A3.js` (`"toString" in true` → TypeError)

**(b) RHS reference evaluation order — the RHS is evaluated (and may throw
`ReferenceError`) after the LHS; we currently throw `Test262Error`/evaluate in
the wrong order:**
- `test/language/expressions/in/S11.8.7_A2.4_T1.js`
- `test/language/expressions/in/S11.8.7_A2.4_T2.js`
- `test/language/expressions/in/S11.8.7_A2.4_T3.js` (expects `ReferenceError`)
- `test/language/expressions/in/S11.8.7_A2.4_T4.js` (`NUMBER is not defined`)

**(c) `in` must consult the prototype chain (`[[HasProperty]]`, not own-only):**
- `test/language/expressions/in/S11.8.7_A4.js` (`"Infinity" in object` after a
  property is set on the object)
- `test/language/expressions/in/S8.12.6_A2_T2.js` (inherited proto property
  `phylum` visible via `in`)

## Acceptance criteria

- `S11.8.7_A3.js` passes: `key in primitive` throws `TypeError`.
- ≥3 of the 4 `S11.8.7_A2.4_T*` evaluation-order tests pass (LHS evaluated
  first, RHS reference resolved, unresolvable RHS → `ReferenceError`).
- Both prototype-chain tests (`S11.8.7_A4.js`, `S8.12.6_A2_T2.js`) pass — `in`
  uses `[[HasProperty]]` (walks the prototype chain), not own-key-only lookup.
- **Target: ≥6 of 7 fixable `in` tests fixed.** No regression in currently-green
  `in` tests.

## Notes
- Spec: ES2023 §13.10.1 `in` operator; `[[HasProperty]]` §10.1.7.
- `language/expressions/in/private-field-*` (ES2022) and `rhs-yield*` /
  `rhs-await*` are intentionally **out of scope** for this issue.
