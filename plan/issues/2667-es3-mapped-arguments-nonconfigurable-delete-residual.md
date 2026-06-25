---
id: 2667
title: "≤ES3: mapped arguments object — non-configurable/non-writable property + [[Delete]] semantics (residual of #1511)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: 0
language_feature: arguments-object
goal: spec-completeness
depends_on: []
related: [1511]
sprint: 66
---
# #2667 — ≤ES3 mapped-arguments non-configurable/non-writable + delete residual

## Edition / impact

- **Edition:** ≤ES3 (base language, sloppy-mode mapped arguments).
- **Fail count:** **12** failing `language/arguments-object/mapped/*` tests.
- Part of the ≤ES3 full-coverage goal (32 total ≤ES3 fails; this is the second
  largest ≤ES3 cluster after #2666).
- Residual after #1511 (arguments-object fidelity, done sprint 57) — the mapped
  argument <-> formal-parameter linkage and descriptor-redefinition path was
  improved but these `[[Delete]]` / non-configurable / non-writable cases still
  fail.

## Problem

In a sloppy-mode function, the `arguments` object is **mapped**: index
properties stay linked to the formal parameters. The spec requires:

- `Object.defineProperty(arguments, "0", {configurable: false})` must succeed,
  and a subsequent `delete arguments[0]` must return **false** (non-configurable
  → delete fails), leaving both `arguments[0]` and the formal `a` at their
  original value.
- Making a mapped property non-writable then deleting/redefining follows the
  mapped-arguments [[DefineOwnProperty]]/[[Delete]] algorithm (ES2015 9.4.4),
  including breaking the parameter map on redefinition.

Current behaviour throws `Cannot redefine property: 0` (runtime_error) or
returns the wrong `delete` result (assertion_fail).

## Failing-test cluster

```
language/arguments-object/mapped/mapped-arguments-nonconfigurable-delete-1.js .. -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js .. -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-3.js
language/arguments-object/mapped/mapped-arguments-nonwritable-nonconfigurable-3.js / -4.js
language/arguments-object/mapped/mapped-arguments-nonconfigurable-nonwritable-5.js
```

Representative (`mapped-arguments-nonconfigurable-delete-1.js`, noStrict):
```js
function argumentsAndDelete(a) {
  Object.defineProperty(arguments, "0", {configurable: false});
  assert.sameValue(delete arguments[0], false);
  assert.sameValue(a, 1);
  assert.sameValue(arguments[0], 1);
}
argumentsAndDelete(1);
```

## Acceptance criteria

- All 12 listed `language/arguments-object/mapped/*` tests pass.
- `delete` on a non-configurable mapped index returns `false`; the value and the
  linked formal parameter are unchanged.
- No regression in the other (passing) arguments-object tests.

## Notes

- Builds on #1511. The fix is in the mapped-arguments exotic-object [[Delete]] /
  [[DefineOwnProperty]] implementation (configurability check before unmap).
