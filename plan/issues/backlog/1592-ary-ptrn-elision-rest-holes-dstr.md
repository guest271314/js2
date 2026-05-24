---
id: 1592
title: "Array pattern elision holes and rest-array in destructuring consume wrong iterator step (~305 fails)"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, array-pattern, for-of, for-await-of, classes
goal: spec-completeness
sprint: Backlog
test262_fail: 305
test262_category: language/statements/class/dstr, language/statements/for-await-of, language/statements/for-of, language/expressions/class/dstr
---
# #1592 — Array pattern elision holes and rest-array in destructuring

## Problem

**305 test262 failures** across class destructuring, for-of, for-await-of, and function-parameter contexts where:

1. **Elision holes** in an array binding pattern (`[, x]`, `[a, , b]`, `[...rest, ,]`) — the iterator step for the elided slot is not consumed, so subsequent bindings read the wrong value
2. **Rest-of-array** patterns with elision (`[...ary]` where the source has holes) — similar miscount

### Error patterns observed

```
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C_method() ← test]

test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C___priv_method() ← test]

test/language/statements/for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js
  returned 2 — assert #1 at L86: assert.sameValue(first, 1);

test/language/statements/for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js
  returned 2 — assert #1 at L67: assert.sameValue(iterations, 1);
```

### Category breakdown (2026-05-24 run, excluding illegal_cast)

| Category | ~Count |
|----------|--------|
| `language/statements/class` (dstr) | ~72 |
| `language/expressions/class` (dstr) | ~72 |
| `language/statements/for-await-of` | ~42 |
| `language/expressions/object` (dstr) | ~34 |
| `language/expressions/async-generator` (dstr) | ~14 |
| `language/statements/for` | ~12 |
| `language/statements/for-of` | ~9 |
| `language/statements/function` | ~9 |
| other | ~41 |

### Root cause hypothesis

`destructureParamArray` (or the equivalent `decl-mode` path after #1553a–d) consumes iterator steps for each binding element in turn. For elision positions, the spec (§13.3.3.8 IteratorDestructuringAssignmentEvaluation step 2: "If BindingElementList contains an elision, call IteratorStep") requires calling `IteratorStep(iterator)` and discarding the result. Our implementation likely skips the `IteratorStep` call for elision positions entirely, meaning subsequent bindings read one-ahead values, and rest/empty patterns receive a null or undefined instead of the remaining iterator.

The `Cannot destructure 'null' or 'undefined'` error on the first binding of a class method (L8) suggests the iterator itself is being passed null where the caller expects an iterable — possibly the method-default parameter elision path doesn't thread the iterator through correctly.

## Acceptance criteria

- `[a,,b] = iter` leaves a one-step gap (spec §13.3.3.8 step 2b)
- `[...rest] = iter_with_elision_source` collects all remaining values correctly
- All ~305 listed test262 files pass
- No regressions in equivalence or existing dstr tests

## Notes

- Not the same as #1555 (streaming IteratorStep-per-element) or #1158/#1159 (eager/empty patterns) — those fixed iterator consumption order; this is specifically about elision slots being silently skipped
- The class/dstr failures at L8:5 ("Cannot destructure null/undefined in C_method") suggest the problem manifests at method param binding, not just local dstr
- Spec reference: ECMA-262 §13.3.3.8 ArrayBindingPattern evaluation, steps for BindingElisionElement
