---
id: 3628
title: "≤ES3 edition: close the remaining 43 host-lane failures (230/273 → 273/273)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen, conformance
language_feature: core-semantics
es_edition: es3
goal: spec-completeness
related: [3486, 2899, 2900]
origin: "2026-07-25 lead measurement: ES3 is the oldest edition and the closest to complete; the remaining gap is 3 issues, not a feature list."
---

# #3628 — ≤ES3 edition: close the remaining 43 host-lane failures

## Why this issue exists

**≤ES3 is the edition closest to done and the cheapest to finish.** The gap is
**not a list of missing features** — every ES3 test compiles. It is three
already-identified defects, one of which accounts for 95% of the failures.

Finishing ES3 gives the project a **fully-closed edition** to point at, and the
dominant defect (#3486) suppresses results well beyond ES3, so the true value
exceeds the ES3 number.

## Measured state (host / `gc` lane, 2026-07-25)

Baseline `test262-current.jsonl` fetched fresh (`--force`; see #3629 — the bare
command is a silent no-op), classified with the exact `classifyEdition` rules
from `scripts/generate-editions.ts`. **Reproduces the published editions figure
exactly: 273 scored / 43 failing** — so these numbers are validated, not
approximated.

|                    |            count |
| ------------------ | ---------------: |
| ≤ES3 scored        |          **273** |
| passing            | **230 (84.2 %)** |
| failing            |           **43** |
| **compile errors** |            **0** |

**Zero compile errors is the headline.** Nothing in ES3 is unimplemented at the
language level; all 43 are runtime-semantics defects.

## The 43, fully attributed

|  count | cluster                                                     | owning issue                                       |
| -----: | ----------------------------------------------------------- | -------------------------------------------------- |
| **41** | custom-exception `.constructor` identity                    | **#3486**                                          |
|      1 | `language/statements/function/13.2-30-s.js`                 | **#2899** (currently `done` — reopened, see below) |
|      1 | `language/module-code/eval-gtbndng-indirect-update-dflt.js` | **#2900** (currently `done` — reopened, see below) |

### The 41 — one defect, not a family (#3486)

33 × `language/expressions/compound-assignment/S11.13.2_A7.*` plus 8 ×
prefix/postfix `++`/`--` (`S11.4.4_A6`, `S11.4.5_A6`, `S11.3.1_A6`,
`S11.3.2_A6`). Every one fails with:

```
Expected a DummyError but got a Array
```

They share one shape — a left-to-right evaluation-order test whose property key
throws a user-defined error:

```js
function DummyError() {}
assert.throws(DummyError, function () {
  var base = null;
  var prop = function () {
    throw new DummyError();
  };
  base[prop()] *= expr();
});
```

**The correct exception IS thrown.** The harness simply cannot identify it: a
user-defined constructor's instance, once thrown and caught on the host side,
reports `.constructor` as a function named `Array`. So the evaluation-order
semantics under test are very likely already correct — this is an identity
defect standing in front of them.

This is the **host-lane twin of #3614**, where `Test262Error`'s `.constructor`
read `undefined` in the standalone lane (fixed 2026-07-25, up to 854 tests).
Same class: constructor identity lost across the throw/catch boundary.

## Acceptance

- [ ] #3486 fixed; re-measure the ≤ES3 bucket and confirm the 41 flip.
- [ ] #2899 and #2900 re-verified against current main (both are marked `done`
      while their tests still fail — see each issue).
- [ ] ≤ES3 reaches 273/273, or every residual failure has a named owning issue
      and a recorded reason.
- [ ] Re-measure with a **force-fetched** baseline (#3629).

## Method note (for whoever re-measures)

Classification is `classifyEdition` in `scripts/generate-editions.ts`. Edition 0
(≤ES3) is the **fall-through**: no `es5id`, no `es6id`, no `features:`, **no
`esid:`** (esid ⇒ ES2015), frontmatter present (absent ⇒ ES5), and no
path heuristic match. A first attempt here that omitted the `esid` and
no-frontmatter rules reported **1,545** failures instead of 43 — a 20× error.
**Validate any re-implementation against the published 273/43 before trusting
it.**
