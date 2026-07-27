---
id: 3684
title: "Generator .return(value) fails to compile: 'Argument of type number is not assignable to parameter of type void'"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3683 — new tests/differential/corpus/generators/03-return-throw.js surfaced this on first run"
related: [3683]
---

# #3684 — Generator `.return(value)` argument type mismatch

## Repro

```js
function* gen() {
  try {
    yield 1;
    yield 2;
  } finally {
    console.log("cleanup");
  }
}
const a = gen();
console.log(a.next().value);
console.log(a.return(99));
```

## Symptom

Compiling this program fails with:

```
compile: Argument of type 'number' is not assignable to parameter of type 'void'.
```

Under V8 this runs the `finally` block and resumes at the `return()` call
site with `{ value: 99, done: true }` — no error. `Generator.prototype.return`
is typed to accept a value of the generator's yield/return type, not `void`;
the compiler appears to be checking the argument against a hardcoded `void`
parameter type for the built-in `.return` method rather than the generator's
actual type parameter.

## Repro file

`tests/differential/corpus/generators/03-return-throw.js` (see #3683).
