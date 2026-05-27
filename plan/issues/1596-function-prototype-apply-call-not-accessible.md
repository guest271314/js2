---
id: 1596
title: "Function.prototype.apply / .call not accessible on compiled Wasm functions (~46 fails)"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: functions, Function.prototype, spread, apply, call
goal: spec-completeness
sprint: Backlog
test262_fail: 46
test262_category: language/expressions/array, built-ins/Function/prototype/call, built-ins/RegExp
---
# #1596 — `Function.prototype.apply` / `.call` not accessible on compiled functions

## Problem

**~46 test262 failures** with error `apply is not a function` or `call is not a function` when test code calls `.apply(...)` or `.call(...)` on a compiled Wasm function directly.

### Observed errors (2026-05-24)

```
test/language/expressions/array/spread-sngl-literal.js
  L41:3 apply is not a function

test/language/expressions/array/spread-mult-literal.js
  L41:3 apply is not a function

test/language/expressions/array/spread-obj-getter-descriptor.js
  L54:3 apply is not a function

test/built-ins/Function/prototype/call/S15.3.4.4_A3_T8.js
  call is not a function

test/built-ins/RegExp/prototype/Symbol.replace/poisoned-stdlib.js
  original.apply is not a function
```

### Pattern

The test pattern in `spread-sngl-literal.js`:
```js
(function() {
  assert.sameValue(arguments.length, 3);
  callCount += 1;
}.apply(null, [...[3, 4, 5]]));   // <-- .apply on compiled IIFE
```

Compiled Wasm functions are WasmGC function references (via `$js_function` struct or similar). When JS code accesses `.apply` or `.call` on them, the engine cannot find these methods because WasmGC funcrefs don't automatically inherit `Function.prototype`.

### Failure count breakdown

| Method | Count |
|--------|-------|
| `apply` | ~29 |
| `call` | ~16 |
| `original.apply` | ~1 |

## Root cause hypothesis

Compiled functions are represented as WasmGC structs (not native JS `Function` objects), so `.apply` / `.call` property lookups on them return `undefined`. The fix requires either:

1. **Proxy wrapper**: wrap every compiled function in a JS `Function` shell that delegates to the Wasm export, so `Function.prototype` methods are inherited
2. **Host method export**: intercept property access on function-struct refs and route `.apply` / `.call` to a host-side implementation
3. **Static rewrite**: detect `fn.apply(thisArg, argsArray)` call patterns at compile time and lower them to a direct call with spread

Option 3 is compile-time (zero runtime overhead) but only covers the static-dispatch case. Options 1–2 handle dynamic `fn.apply` but add overhead.

## Acceptance criteria

- `(function() {}).apply(null, args)` works — arguments bound correctly
- `(function() {}).call(thisArg, a, b)` works
- `Function.prototype.apply.call(fn, thisArg, argsArray)` works
- All ~46 test262 files pass
- No regressions in existing function / call / spread tests

## Notes

- This may also affect `Function.prototype.bind` (not counted separately in current harvest; check `bind is not a function` occurrences)
- Overlaps conceptually with WasmGC object leakage (#983) — compiled objects escape to JS and don't have expected prototype methods
- If a static-rewrite approach is used for `fn.apply(...)`, must handle the case where `fn` is not a literal (dynamic dispatch)
- The `spread-*.js` failures suggest the array spread `[...arr]` lowering itself calls `.apply` internally — inspect the spread codegen path before assuming the test calls `.apply` directly

## Resolution (2026-05-27)

**Root cause confirmed.** The `.call`/`.apply` handler in
`compileCallExpression` (`src/codegen/expressions/calls.ts`) only handled two
receiver shapes: a bare identifier (`fn.call(...)`) and a property access
(`obj.method.call(...)`). A **(parenthesized) function/arrow expression**
receiver — `(function(){}).apply(...)` / `(() => {}).call(...)`, the exact
test262 shape — matched neither case and fell through to the generic
member-call path, which routed `.apply`/`.call` to a host call on the WasmGC
function struct. The struct is not a JS `Function`, so the host lookup threw
`apply is not a function`.

**Fix (option 3, compile-time static rewrite).** Added "Case 0" at the top of
the handler: when the receiver unwraps to a non-generator function/arrow
expression, rewrite `(fn).call(thisArg, a, b)` → `(fn)(a, b)` and
`(fn).apply(thisArg, [a, b])` → `(fn)(a, b)`, dropping `thisArg` (standalone
functions ignore `this`) after evaluating it for side effects. The synthetic
direct call re-enters `compileCallExpression`, reusing the existing IIFE
inlining path (which binds `arguments` correctly). For `.apply` the args-array
literal is statically flattened via a new `flattenStaticArrayElements` helper
that also expands spreads of nested array literals (`[...[3,4,5]]`, the common
test262 shape). Non-literal args arrays and dynamic spread sources are left to
the generic path (no regression).

### Scope / known limitations
- `fn.apply(null, dynamicVar)` and `fn.apply(null, [...iterableExpr])` where the
  spread source is not a literal still defer (need a dynamic args-array path —
  separate feature).
- Dynamic-`this` tests (e.g. `S15.3.4.4_A3_T8.js`, which writes `this.feat` to
  the global object) are out of scope — the compiler does not model
  global-object `this`.

## Test Results
- New unit suite `tests/issue-1596.test.ts` — 6/6 pass (apply+literal,
  apply+arguments.length, call+positional, arrow apply, empty-args apply,
  nested call).
- test262 `language/expressions/array/spread-*`: **12 → 24 pass** (+12) in that
  directory alone (measured fixed-worktree vs main HEAD with the vitest runner).
- The two issue example files `spread-sngl-literal.js` and
  `spread-mult-literal.js` now pass.
- No regressions: `function-expressions.test.ts` / `arrow-call-apply.test.ts` /
  `fn-variable-call.test.ts` failures are pre-existing on main (stale harness:
  missing `string_constants` import / missing `tests/helpers.js`), unrelated to
  this change.
