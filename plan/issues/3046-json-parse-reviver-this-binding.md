---
id: 3046
title: "JSON.parse reviver: `this` is not bound to the holder object (Object.defineProperty(this,…) in a reviver throws called-on-non-object)"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
created: 2026-07-05
task_type: bugfix
area: runtime
language_feature: json-parse
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022]
---

# #3046 — JSON.parse reviver `this`-binding to the holder

Split from the #3022 umbrella (the "called on non-object" cluster — JSON/parse
sub-group). **Developer-scoped, bounded.**

## Root cause

Per ECMA-262 `InternalizeJSONProperty`, the reviver is invoked as
`Call(reviver, holder, «name, val»)` — i.e. `this` inside the reviver MUST be
the **holder** object/array. Our `JSON.parse` reviver invocation does not bind
`this` to the holder, so inside the reviver `this` is a non-object; a
`Object.defineProperty(this, k, …)` (or any `this.`-op on the holder) throws
`Object.defineProperty called on non-object`.

## Failing files (4)

`reviver-array-non-configurable-prop-delete.js`,
`reviver-array-non-configurable-prop-create.js`,
`reviver-object-non-configurable-prop-delete.js`,
`reviver-object-non-configurable-prop-create.js`.

## Minimal repro

```js
JSON.parse('[1,2]', function (key, value) {
  if (key === '0') Object.defineProperty(this, '1', { configurable: false });
  // `this` must be the holder array — currently non-object ⇒ throws
  return value;
});
```

## Layer to fix

`src/runtime.ts` — the `JSON.parse` reviver call site: pass the holder as the
`this` receiver of the reviver call (and make the holder a real object the
reviver's `this.`-operations accept). The `[[Delete]]`/`[[DefineOwnProperty]]`
on the holder must observe the descriptor tombstone semantics (see #2726 c/d).

## Acceptance

- The 4 reviver tests pass; `this` inside a reviver is the holder. Scope: **DEV**.
