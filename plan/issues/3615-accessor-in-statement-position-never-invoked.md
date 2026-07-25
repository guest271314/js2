---
id: 3615
title: "Silent wrong answer: a property read in expression-statement position never invokes the accessor — the getter's observable effects, including its throw, are dropped"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
goal: core-semantics
created: 2026-07-25
---

## Problem

```js
var o = {
  get p() {
    throw new Test262Error("accessor must run");
  },
};
o.p; // ← statement position: the accessor is NEVER invoked
```

The program above **runs to completion and scores `pass`** through the real
test262 oracle, in **both** lanes. Per §13.3.2.1 / §6.2.5.5 (GetValue on a
Reference) the read is observable: it must call `[[Get]]`, which for an
accessor property calls the getter. Dropping it is a spec violation, and in the
conformance number it is a **vacuous pass** — the exact class #3592 was about.

Found on 2026-07-25 by the first run of the #3613 harness truth table.

## Evidence — controlled, through the real oracle

All rows below are synthetic test262 files run through `runTest262File` (the
same `assembleOriginalHarness` assembly CI scores with). Ground truth for the
first three is `fail`.

| #   | program                                                                             | verdict  |
| --- | ----------------------------------------------------------------------------------- | -------- |
| A   | `var o = { get p() { throw new Test262Error("A"); } }; o.p;`                        | **pass** |
| B   | `var o = { get p() { throw new Test262Error("B"); } }; var v = o.p;`                | fail     |
| C   | `var o = { get p() { throw new Test262Error("C"); } }; assert.sameValue(o.p, 1);`   | fail     |
| D   | `var o = {}; Object.defineProperty(o, "p", { get: function () { throw … } }); o.p;` | **pass** |
| E   | same as D but `assert.sameValue(o.p, 1);`                                           | fail     |
| F   | `class C { get p() { throw new Test262Error("F"); } } var c = new C(); c.p;`        | **pass** |
| G   | same as F but `assert.sameValue(c.p, 1);`                                           | fail     |

The defect is in the **read form**, not the accessor kind: object-literal,
`Object.defineProperty` and class accessors all drop, and all three work when
the value is consumed.

### It is NOT-INVOKED, not invoked-but-throw-swallowed

The decisive pair uses a side effect instead of a throw, so no exception
machinery is involved:

| #   | program                                                                                                            | verdict  | meaning          |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------- | ---------------- |
| H   | `var hit = 0; var o = { get p() { hit = 1; return 1; } }; o.p; assert.sameValue(hit, 1, "must have run");`         | **fail** | `hit` is still 0 |
| I   | `var hit = 0; var o = { get p() { hit = 1; return 1; } }; var v = o.p; assert.sameValue(hit, 1, "must have run");` | pass     | `hit` became 1   |

Same file shape; only the read form differs. H proves the getter body never
executes.

### Controls that are NOT affected

`f();` (plain call in statement position) and `o.m();` (method call in
statement position) both fail correctly, so statement-position expressions are
not dropped in general — it is specifically a **property/element read whose
value is unused**. `void o.p;` and `o["p"];` drop the same way.

## Impact

Two directions, both bad:

- **Vacuous passes** — any corpus test whose whole point is "reading this
  property must throw/observe", written as a bare `obj.prop;` statement.
- **False FAILs** — the very common `assert.throws(TypeError, function () { obj.prop; });`
  shape: the read inside the callback is a statement, so nothing throws and the
  assertion reports "no exception was thrown at all". These are counted as
  compiler failures today when the real defect is the dropped read.

Not sized against the corpus here (sizing needs a full re-run; see
`plan/issues/3613-*.md` for why that measurement was out of budget). The shape
is pervasive in `built-ins/**/prop-desc.js`, the `return-abrupt-from-*` family
and the `Symbol.toPrimitive`/`valueOf` hook tests.

## Pinned

Three `it.fails` entries in `tests/test262-harness-truth-table.test.ts` (F1–F3)
assert the TRUTH and are expected to fail today; F4/F5 are the H/I control
pair and pass. **When this is fixed, F1–F3 start passing and vitest reports
"expected test to fail"** — the file goes red and forces the entries to be
retired. The debt cannot rot silently.

## Where to look

`compileStatement`'s `ExpressionStatement` arm
(`src/codegen/statements.ts:159`) is NOT the culprit — it calls
`compileExpression` unconditionally and drops the result. The drop is inside
the property-read lowering, which must be emitting nothing (or a pure
`struct.get`) when the value is unused, instead of dispatching to the accessor.
Reproduce with the H/I pair above; `hit` is the observable that removes all
exception-machinery confounds.

## Acceptance criteria

- [ ] H (statement-position read) sets `hit` to 1 — the accessor runs
- [ ] A, D, F are observed as `fail` (the accessor's throw propagates)
- [ ] B, C, E, G, I are unchanged (no regression on the consumed-read path)
- [ ] F1–F3 in `tests/test262-harness-truth-table.test.ts` are moved out of the
      known-wrong tier (drop `knownWrong`, they become ordinary `it`s)
- [ ] `assert.throws(TypeError, function () { obj.prop; })` reaches the getter
