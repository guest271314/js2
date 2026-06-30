---
id: 2676
title: "≤ES3: mapped arguments — strict-mode aliased `delete args[i]` must throw TypeError on a non-configurable index (residual of #2667)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 0
language_feature: arguments-object
goal: spec-completeness
depends_on: []
related: [2667, 1511]
sprint: current
---
# #2676 — ≤ES3 mapped-arguments strict aliased delete throws (residual of #2667)

## Edition / impact

- **Edition:** ≤ES3 (sloppy mapped `arguments`, but the delete site is strict).
- **Fail count:** **4** `language/arguments-object/mapped/*` tests.
- Residual carved out of #2667 (which fixed the 8 non-strict cases). Part of the
  ≤ES3 full-coverage goal.

## Problem

```
language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js .. -4.js
```

Representative:
```js
function argumentsAndStrictDelete(a) {
  Object.defineProperty(arguments, "0", { configurable: false });
  var args = arguments;                                  // (1) alias
  assert.throws(TypeError, function() {                  // (3) nested fn
    "use strict";                                        // (2) strict context
    delete args[0];                                      //     must THROW
  });
  assert.sameValue(a, 1);
  assert.sameValue(arguments[0], 1);
}
argumentsAndStrictDelete(1);
```

In **strict** mode, `delete` of a non-configurable own property throws a
TypeError (§13.5.1.2 / OrdinaryDelete with `Throw = true`). Currently the
compiled `delete args[0]` returns normally (the test then fails the
`assert.throws`).

Three things make this harder than the #2667 static path:

1. **Aliasing** — the receiver is `args` (a `var` initialized to `arguments`),
   not the literal `arguments` identifier #2667's tracking keys on.
2. **Strict context** — the delete is inside a nested non-arrow function with
   its own strict prologue, so `args` is a closure capture and the strict bit
   lives on the inner function, not the outer mapped one.
3. **Conditional throw** — must emit a runtime TypeError only when the target
   index is non-configurable.

## Acceptance criteria

- All 4 `mapped-arguments-nonconfigurable-strict-delete-*` tests pass.
- No regression in the #2667 non-strict mapped cases or the rest of
  `language/arguments-object/mapped`.

## Notes

- The #2667 fix tracks per-index `nonConfigurableIndices` in `mappedArgsInfo` at
  compile time. A solution here likely needs either (a) alias-resolution from
  `args` back to the captured `arguments` vec + the outer function's
  `mappedArgsInfo`, or (b) a runtime descriptor on the arguments object so a
  strict `delete` consults real configurability and throws. Option (b) overlaps
  with the broader arguments-object descriptor-fidelity gap (#2668).
