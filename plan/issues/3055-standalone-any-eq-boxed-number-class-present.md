---
id: 3055
title: "Standalone `any === any` on boxed numbers returns equal-for-unequal when an object-runtime/class is present"
status: ready
created: 2026-07-05
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: strict-equality, any-boxing, standalone
es_edition: ES2015
test262_category: (broad — numeric equality)
goal: standalone-mode
related: [3054, 3056]
---

# #3055 — Standalone boxed-number strict-equality miscompiles when a class is present

## Summary

In the **standalone / WASI lane**, `a === b` where both operands are `any`-typed
(tag-boxed) **numbers** returns the WRONG result — it answers _equal_ for
**unequal** numbers — **when the module also defines a class** (or otherwise
pulls in the object-runtime / tag machinery). Two boxed numbers `1` and `2`
compare `===` as `true`. This is a real correctness miscompile that affects **user
programs**, not just the test harness — it was _discovered_ via the harness (see
#3054 measurement-integrity finding) but is not harness-specific.

## Reproduction (all on `upstream/main`, `--target standalone`)

Verified via `compile(src, { target: "standalone" })` + `instantiateWasm`:

```ts
function eq(a: any, b: any): number {
  return a === b ? 1 : 0;
}
export function test(): number {
  return eq(1, 2);
} // → 0 (CORRECT, no class)
```

```ts
// The SAME with a class in the module regresses through the harness path:
// via the real test262 wrapTest, `assert.sameValue(1, 2)` returns test()=1 (PASS)
// in standalone but 2 (FAIL) in host. Bisection: removing the unconditionally
// injected `class Test262Error { ... }` from the wrapped source flips standalone
// 1 → 2. So: class present + any-boxed numeric `===` → equal-for-unequal.
```

- **Minimal `eq(1,2)` + a class** did NOT reproduce in isolation — the trigger
  needs the fuller module shape the harness produces (class + the `isSameValue`/
  `assert_sameValue` nest + the other `any`-param shims). The **robust, stable
  repro** is: the real `tests/test262-runner.ts#wrapTest` output for
  `assert.sameValue(1, 2)`, compiled `--target standalone`, returns `test()=1`;
  delete `class Test262Error` → returns `2`. (Transcript in the #3054 discussion.)
- **String** operands are unaffected: `assert.sameValue("a","b")` → 2 (FAIL) in
  both lanes. Only the boxed-**number** `===` path miscompiles.

## Suspected root cause (for the architect)

The object-runtime / tag allocation (registered when a class exists) perturbs the
**tag-boxed number strict-equality** path — likely the tag-5/tag-6 boxed-primitive
`===` arm (see memory `reference_1629b_boxed_primitive_typeof_eq_layers`,
`reference_2040_tag5_field4_three_way_classifier`, `reference_2583_any_strict_eq_tag5_host_only`).
The hypothesis: with an object-runtime present, two boxed f64s route through a
ref-identity / same-tag arm that answers identity (or a vacuous constant) instead
of unboxing and comparing the f64 values. Needs a WAT-level trace of `any === any`
on two boxed numbers with vs. without a class registered, to find the diverging arm.

## Why this matters

- **User-program correctness**: any standalone program that compares two
  `any`/`unknown`-typed numbers with `===` (or `!==`) in a module that also has a
  class can silently get the wrong answer.
- **Measurement integrity**: it is the mechanism behind the standalone floor NOT
  enforcing numeric assertions (#3056) — a large fraction of numeric-heavy
  standalone "passes" are vacuous because the harness's `isSameValue` rides this
  path. Fixing #3055 is the _correct_ fix; #3056 (harness `_num` routing) only
  sidesteps it.

## Acceptance criteria

- `eq(a: any, b: any) => a === b` returns the correct result for two boxed numbers
  in standalone **regardless of whether the module defines a class**.
- The real `wrapTest` output for `assert.sameValue(1, 2)` returns `test()=2`
  (FAIL) in standalone, matching host.
- No regression to boxed-string / boxed-object / mixed `===` (tag-5/6 arms).
- **Coordinated with #3056**: enforcing numeric asserts will turn currently-vacuous
  numeric standalone "passes" into honest FAILS → the `host_free_pass` floor DROPS.
  This is a deliberate measurement RE-BASELINE (the floor gate would auto-park it
  as a false regression) and a **human decision** — do NOT land unilaterally under
  the autonomous loop. See #3056.
