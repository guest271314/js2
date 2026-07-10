---
id: 3130
title: "Standalone: native Error objects lack `.constructor` / `.name` — blocks resolve-settled-*-self acceptance"
status: ready
sprint: current
created: 2026-07-10
updated: 2026-07-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: errors
goal: standalone-mode
related: [3128, 3125, 2980]
origin: "#3128 drill — after the assignment/capture fix (A+B) and the zero-arg resolve() dispatch fix (C), the resolve-settled-*-self files fail ONLY on `reason.constructor !== TypeError`"
---

# #3130 — native Error `.constructor` / `.name` identity (standalone)

## Problem (measured on the #3128 branch, standalone, 2026-07-10)

```ts
export function test(): number {
  var e: any = new TypeError("x");
  return e.constructor === TypeError ? 1 : 0; // ← returns 0
}
```

- `e.constructor` reads back `undefined` (probe: `.tmp/repro-3128-ctor2.mts`
  in the #3128 worktree — recreate trivially from the snippet above).
- `e.name === 'TypeError'` ALSO fails (returned r=11 in the
  instanceof/name probe: instanceof TypeError ✓, instanceof Error ✓,
  `.name` ✗).
- `typeof e.constructor` throws "Cannot convert object to primitive value".
- Same result for a CAUGHT TypeError (`try { null.foo } catch (e) {…}`).
- `e instanceof TypeError` / `e instanceof Error` both work — the brand
  chain is fine; only the property surface is missing.

## Why it matters

`test262/test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-self.js`
and `resolve-settled-rejected-self.js` (the #3128 acceptance files) assert the
§27.2.1.3.2 self-resolution rejection via
`reason.constructor !== TypeError`. After #3128 landed the capture/assignment
fix and the zero-arg `resolve()` dispatch fix, the whole promise machinery is
spec-correct on the widened standalone lane (verified: the reject handler runs
with a TypeError instance, `instanceof` passes) — the ONLY remaining failure
is this property read. The pattern (`err.constructor === XError`, `err.name`)
is a common test262 idiom, so the fix likely flips more than these two files.

## Acceptance

- `new TypeError('x').constructor === TypeError` → true (standalone, and the
  other native error ctors: Error/RangeError/ReferenceError/SyntaxError/
  EvalError/URIError).
- `new TypeError('x').name === 'TypeError'` → true; `.name` inherited
  per spec (own property of the ctor prototype, not the instance).
- Caught runtime-thrown errors (e.g. null deref TypeError) expose the same
  `.constructor` / `.name`.
- `resolve-settled-fulfilled-self.js` + `resolve-settled-rejected-self.js`
  flip to pass on the widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`,
  `runTest262File(..., "standalone")`).
- No regressions in the error-object suites.

## Notes

- The identity requirement is two-sided: the error struct's `.constructor`
  read must return the SAME function object the bare `TypeError` identifier
  evaluates to (strict-equality on the binding, not just a same-named
  function). Check how `instanceof` resolves the ctor brand — the fix can
  likely reuse that anchor.
- Related pre-existing gap seen in the same drill (do NOT conflate): `===`
  identity on $Promise values routed through any-typed vars fails standalone
  (`seen === p1` false even with no self-capture — the tag-5 host-only
  strict-eq arm, see `reference_2583_any_strict_eq_tag5_host_only`).
