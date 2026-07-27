---
id: 3686
title: "yield* delegation to an inner generator traps with 'illegal cast'"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3683 — new tests/differential/corpus/generators/05-yield-star.js surfaced this on first run"
related: [3683]
---

# #3686 — `yield*` delegation traps with "illegal cast"

## Repro

```js
function* inner() {
  yield "a";
  yield "b";
  return "inner-done";
}
function* outer() {
  const result = yield* inner();
  yield "c:" + result;
}
console.log([...outer()].join(","));
```

## Symptom

- V8: `a,b,c:inner-done`
- js2wasm: compiles, but throws a runtime `illegal cast` trap when the
  program runs — no output at all (the whole program errors before the
  first `console.log`).

Both `inner` and `outer` are plain generator functions individually
exercised (see #3683's `01-basics.js`), so the gap is specific to
`yield*` delegating from one generator to another (the recursive
`flatten` case in the same corpus file, which delegates to itself, was
never reached because the harness stops at the first error — worth
re-checking once this is fixed).

## Repro file

`tests/differential/corpus/generators/05-yield-star.js` (see #3683).
