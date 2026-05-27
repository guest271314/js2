---
id: 1596
title: "Function.prototype.apply / .call not accessible on compiled Wasm functions (~46 fails)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: functions, Function.prototype, spread, apply, call
goal: spec-completeness
sprint: 56
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
