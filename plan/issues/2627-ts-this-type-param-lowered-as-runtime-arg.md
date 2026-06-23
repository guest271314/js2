---
id: 2627
title: "TS type-only `this` parameter lowered as a runtime arg → argument shift"
status: backlog
sprint: Backlog
created: 2026-06-22
priority: lowest
feasibility: medium
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: typescript-this-param
origin: "2026-06-22 dev-acorn — found while probing #2608. NOT an acorn blocker (acorn uses no `this:` annotations) and 0 test262 files exercise it."
---

# #2627 — TS type-only `this` parameter lowered as a runtime arg

A TypeScript `this` parameter (`function f(this: T, a, b) {}`) is a **type-only**
pseudo-parameter that must be erased from the runtime ABI. js2wasm currently
counts it as a real Wasm parameter, so all real arguments shift by one:

```ts
function add(this: any, a: number, b: number): number {
  return a + b;
}
add(3, 4); // returns 4 (reads `b` where `a` should be) — should be 7
```

The fix: skip a leading parameter whose name is the `this` keyword everywhere a
function's `parameters` become Wasm param locals/types (regular functions,
function-expressions, fnctors). Care needed vs. the real instance-method `this`
receiver (param 0 for instance methods), which is distinct from the TS
`this`-annotation pseudo-param.

**Priority: lowest.** Affects **0 test262 files** and **0 acorn source** — a
pure-TypeScript construct with no conformance/dogfood value. Recorded for
completeness; defer indefinitely.
