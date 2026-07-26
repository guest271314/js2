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
**not a list of missing features** — every ES3 test compiles. It is four
already-identified defects (#3486 ✅, #2666, #2899, #2900).

> The original wording — "three already-identified defects, one of which
> accounts for 95% of the failures" — was measured wrong. #3486 accounted for
> **11 of 43 (26 %)**, not 41 of 43 (95 %); the 95 % figure counted tests whose
> _message_ matched, not tests the fix would flip. #2666 is the larger cluster
> at ~30. See the correction in the attribution table below.

Finishing ≤ES3 gives the project a **fully-closed edition** to point at, and
#3486 did suppress results well beyond ≤ES3 (28 tests fixed across eight
top-level areas), so the true value still exceeds the ES3 number — that part
held up.

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

> **CORRECTED 2026-07-25 after #3486 landed.** The table below attributed all 41
> to #3486 and the acceptance criterion said "confirm the 41 flip." **Measured:
> 11 flip, not 41.** The attribution METHOD was sound — it reproduces the
> published editions figure exactly — but it grouped by a shared _error message_,
> and a shared symptom is not a single blocker. Each of these files contains
> **two** `assert.throws` calls; #3486 was the first one's blocker, and the other
> 30 fail on the second with a genuinely different root cause. Corrected split:

|  count | cluster                                                          | owning issue                                       |
| -----: | ---------------------------------------------------------------- | -------------------------------------------------- |
| **11** | custom-exception `.constructor` identity                         | **#3486** ✅ fixed 2026-07-25                      |
| **30** | `RequireObjectCoercible(base)` must precede `ToPropertyKey(key)` | **#2666** (measured attribution added there)       |
|      1 | `language/statements/function/13.2-30-s.js`                      | **#2899** (currently `done` — reopened, see below) |
|      1 | `language/module-code/eval-gtbndng-indirect-update-dflt.js`      | **#2900** (currently `done` — reopened, see below) |

So ≤ES3 goes **230/273 → 241/273** with #3486, and **#2666 is now the dominant
remaining cluster** — worth ~30, taking the bucket to ~271/273.

The 30 residuals all report `Expected a TypeError but got a Test262Error`. The
probe that localised it (host lane, isolated): a plain read `base[prop]` with
`base === null` correctly throws `TypeError` _before_ `ToPropertyKey`, but
`base[prop] &= expr()` and `++base[prop]` both evaluate the key first, so a
throwing `prop.toString()` escapes ahead of the required TypeError. The plain
member-read path has the order right; the read-modify-write member paths do not.

### The 41 — originally read as one defect; measured as two (#3486 + #2666)

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
user-defined constructor's instance reports `.constructor` as a function named
`Array`.

> **Two corrections from #3486's investigation.**
>
> 1. **The throw/catch boundary is NOT involved.** This paragraph originally
>    said "once thrown and caught on the host side," and #3486's own issue file
>    hypothesised an exception-marshaling defect. Both were **disproven by
>    probe**: a plain `new MyError("x")` that is _never thrown_ reports
>    `.constructor.name === "Array"` identically. It is the ordinary
>    property-read path. (Root cause: a vec discriminator that was vacuously
>    true for every WasmGC struct, because `__vec_len`'s not-a-vec default is
>    `0` and the guard tested `typeof len === "number"`.)
> 2. **"The evaluation-order semantics are very likely already correct" was
>    half right.** For 11 of the 41, yes. For the other 30 the evaluation order
>    is genuinely wrong too — just a different aspect of it than these tests'
>    first assertion probes (`RequireObjectCoercible` ordering, #2666). The
>    identity defect was standing in front of a real second defect, not in front
>    of correct behaviour.

It is still the **host-lane twin of #3614**, where `Test262Error`'s
`.constructor` read `undefined` in the standalone lane (fixed 2026-07-25, up to
854 tests) — same _question_ (an instance's constructor back-pointer), though
the two lanes turned out to need **different mechanisms**, not one shared fix
(host: the `_fnctorInstanceCtor` WeakMap; standalone: WasmGC globals), exactly
as #3617 predicted.

## Acceptance

- [x] #3486 fixed; ≤ES3 bucket re-measured. **11 flipped, not 41** — the
      "confirm the 41 flip" wording was a forecast dressed as a count and is
      corrected above. 230/273 → 241/273.
- [ ] #2666 fixed (`RequireObjectCoercible` before `ToPropertyKey` in the
      read-modify-write member paths); re-measure — expected ~30, **to be
      measured, not assumed.**
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
