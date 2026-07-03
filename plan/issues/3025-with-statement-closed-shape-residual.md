---
id: 3025
title: "with statement: closed object-literal shape residual (~167 default-lane fails, CE leaks into unrelated with-adjacent tests)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: with-statement, dynamic-scope
goal: spec-completeness
test262_category: language/statements/with
test262_fail: 167
related: [1387]
---

# #3025 — `with` statement: closed-shape residual

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **167**
official fails in `language/statements/with`: 140 runtime assertion failures
+ 27 compile errors of the form `with statement requires a proven closed
object-literal shape`. #1387 implemented `with`'s dynamic-scope lookup; this
residual is the CE-gate + correctness tail for object shapes the closed-shape
prover can't (yet) prove closed, plus runtime behaviors (unscopables,
property-get error propagation) not fully wired.

## Sample failing files

- `language/statements/with/unscopables-prop-get-err.js`
- `language/statements/with/S12.10_A1.12_T2.js`

## Suggested approach

1. Check whether the "proven closed object-literal shape" CE gate can be
   relaxed for more shapes (e.g. object literals with computed keys, spread,
   or method shorthand) without giving up soundness, or whether those shapes
   need a slower dynamic-lookup fallback instead of an outright refusal.
2. For the runtime tail: verify `Symbol.unscopables` filtering is applied to
   every property-get/set inside a `with` body, and that thrown errors from
   the object's property accessors propagate correctly through the `with`
   scope chain lookup.

## Acceptance criteria

- `language/statements/with` fail count drops materially below 167.
- The "requires a proven closed object-literal shape" CE no longer fires on
  a representative sample of the 27 currently-affected files, without
  regressing any test that correctly relies on the refusal for genuinely
  unprovable shapes.
