---
id: 3046
title: "JSON.parse reviver: `this` is not bound to the holder object (Object.defineProperty(this,…) in a reviver throws called-on-non-object)"
status: done
sprint: 71
priority: medium
horizon: s
feasibility: medium
created: 2026-07-05
completed: 2026-07-05
assignee: ttraenkler/dev-3042
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

## Resolution (2026-07-05, dev-3042)

**Root cause.** A JSON.parse reviver that reads `this` was wrapped via the bare
`__make_callback` bridge — an arrow that drops the JS receiver. The reviver body
reads `this` from the `__current_this` module global, which nothing installs on
that path, so `this` was a non-object and any `this.`-op
(`Object.defineProperty(this,…)`, `this[k]`) threw "called on non-object".
The runtime's `_invokeJsonCallable` already applies the holder as the JS
receiver (`fn.apply(holder, …)`); the gap was purely codegen — the reviver
needed the `this`-forwarding `__make_getter_callback` bridge (which the
accessor path already uses).

**Fix (two coordinated changes).**
- `src/codegen/closures.ts` — `compileArrowFunction` passes `needsThis` for the
  2nd argument of a `JSON.parse(...)` call whose body references `this`
  (new `isJsonReviverArgument` + exported `functionBodyReferencesThis`,
  gated so ordinary callbacks — `map`/`forEach` etc. — are untouched). This
  routes the reviver through `__make_getter_callback`, so the host forwards
  `holder` as the receiver and the `__cb` body binds `this` to it.
- `src/codegen/declarations.ts` — the collect pre-pass registers the
  `__make_getter_callback` import for such revivers. Without this the needsThis
  emit referenced an unregistered import, leaving the reviver **silently
  non-callable** (JSON.parse returned unfiltered) — a false pass that still
  satisfied the 4 acceptance tests because they assert the *original* values.
  The pre-pass wiring makes the reviver genuinely run.

**Impact.** +8 `built-ins/JSON/parse` reviver rows flip to pass — the 4
non-configurable create/delete acceptance tests plus
`reviver-{array,object}-get-prop-from-prototype`, `reviver-object-own-keys-err`,
`revived-proxy-revoked`. **0 regressions** across the JSON/parse suite.
Correctness confirmed with `assertEquivalent` (wasm output matches native JS:
`this.length` / `this[k]` observable inside the reviver, and reviver return
values applied), not just test262 value-assertions.

Tests: `tests/issue-3046.test.ts`.
