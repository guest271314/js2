---
id: 2666
title: "≤ES3: member-reference base[prop] evaluation order in compound-assignment and prefix/postfix ++/-- (ToPropertyKey once, left-before-right)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: compound-assignment, increment-decrement, evaluation-order
goal: spec-completeness
sprint: 66
---
# #2666 — ≤ES3 member-reference `base[prop]` evaluation order (compound-assign + ++/--)

## Edition / impact

- **Editions:** ≤ES3 (base language) + ES5 + ES2015 (same root cause spans all three).
- **Fail count (current baseline):**
  - ≤ES3: 11 `compound-assignment/S11.13.2_A7.*_T4.js` + 4 `prefix/postfix-(in|de)crement/*_A6_T2.js` = **15**.
  - ES5: 77 `language/expressions/compound-assignment` + ~32 `prefix/postfix-(in|de)crement` (es5id-tagged) overlap the same root.
  - ES2015: 22 `language/expressions/compound-assignment`.
  - **Net addressable cluster ≈ 100+ failing tests** sharing one codegen root.
- This is the **top ≤ES3 priority** — it is base-language semantics every edition inherits.

## Problem

For an assignment target of the form `base[prop]` the spec requires:
1. Evaluate `base` (the MemberExpression's object) **once**.
2. Evaluate `prop` and apply `ToPropertyKey` **exactly once** — left-hand side
   before the right-hand side operand.
3. For compound assignment `base[prop] op= expr`, read the current value using
   the *already-evaluated* reference, compute `op`, then write back to the
   *same* reference — without re-evaluating `base` or re-calling `ToPropertyKey(prop)`.
4. For `++base[prop]` / `base[prop]++` (and `--`), the reference is evaluated
   once; `base = undefined` must throw **before** the property key is evaluated
   (GetValue on the base reference happens first).

Current codegen re-evaluates the property-key expression (and/or `base`) more
than once, so `prop.toString()` side effects fire twice and ordering asserts
fail. The `base = undefined` cases also evaluate `prop` when they should throw
on the base first.

## Failing-test cluster (examples)

```
language/expressions/compound-assignment/S11.13.2_A7.1_T4.js   (base[prop] *= expr — ToPropertyKey once)
language/expressions/compound-assignment/S11.13.2_A7.2_T4.js   (... and A7.3..A7.11 — one per operator)
language/expressions/prefix-increment/S11.4.4_A6_T2.js         (++base[prop], base undefined throws before prop)
language/expressions/postfix-increment/S11.3.1_A6_T2.js
language/expressions/prefix-decrement/S11.4.5_A6_T2.js
language/expressions/postfix-decrement/S11.3.2_A6_T2.js
```

Representative assertion (`S11.13.2_A7.1_T4.js`):
```js
var propKeyEvaluated = false;
var prop = { toString: function() { assert(!propKeyEvaluated); propKeyEvaluated = true; return ""; } };
base[prop] *= expr();   // toString must be called EXACTLY once
```

## Acceptance criteria

- All 11 `compound-assignment/S11.13.2_A7.*_T4.js` pass.
- All 4 `prefix/postfix-(in|de)crement/*_A6_T2.js` pass.
- No regression in the broader compound-assignment / inc-dec test set.
- Property-key expression with observable `toString`/`valueOf` side effects is
  evaluated exactly once for `base[prop] op= rhs` and `++/-- base[prop]`.

## Notes

- Root cause is in the member-target lowering for compound-assignment and
  update expressions — likely a "compile the target twice (once to read, once to
  write)" pattern. Fix: evaluate `base` and the property key once into temps,
  then read/modify/write through the temps.
- Related (different root): #1938 (linear array element double-eval of RHS).
