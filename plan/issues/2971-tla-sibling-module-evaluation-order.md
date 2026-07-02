---
id: 2971
title: "codegen: async (TLA) module must not block evaluation of sibling modules in the graph"
status: ready
priority: medium
sprint: Backlog
created: 2026-07-02
feasibility: hard
task_type: bug
area: codegen
language_feature: module-code
goal: spec-completeness
related: [2932]
---

# #2971 — top-level-await module must not block sibling module evaluation

Split from #2932's honest-regression bucket. Exposed when `.js` fixture
modules started compiling for real (#2932): the baseline "pass" was the
null-import artifact.

## Failing test

`test/language/module-code/top-level-await/async-module-does-not-block-sibling-modules.js`

```js
import "./async-module-tla_FIXTURE.js"; // suspends on top-level await
import { check } from "./async-module-sync_FIXTURE.js";
assert.sameValue(check, false); // sync sibling must already have evaluated
```

## Spec

sec-innermoduleevaluation — while an asynchronous module awaits, sibling
modules in the graph continue evaluating; the entry's evaluation observes the
sync sibling's completed state.

## Direction

Multi-file codegen currently evaluates module initializers strictly
sequentially in one `__module_init`-style chain; an async (TLA) module needs
its continuation deferred (microtask ring) without blocking the next module's
initializer. Related to the #2895 microtask-drain infrastructure.

## Acceptance

- `async-module-does-not-block-sibling-modules.js` passes via the test262
  runner (async flag / $DONE path).
- No regression in the other `top-level-await/` module tests.
