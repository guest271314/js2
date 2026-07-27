---
id: 3687
title: "Two generator instances created from the same closure-returning factory corrupt each other's captured state"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: high
horizon: m
feasibility: hard
task_type: bugfix
area: codegen, runtime
language_feature: generators
goal: generator-model
origin: "#3683 — new tests/differential/corpus/generators/06-closure-state.js surfaced this on first run"
related: [3683]
---

# #3687 — Concurrent generator instances from a shared closure factory corrupt captured state

## Repro

```js
function makeCounter() {
  let total = 0;
  return function* () {
    while (true) {
      total += 1;
      yield total;
    }
  };
}
const start = makeCounter();
const g1 = start();
const g2 = start();
console.log(g1.next().value); // 1
console.log(g1.next().value); // 2
console.log(g2.next().value); // 3 (shares `total` with g1 — same closure)
console.log(g1.next().value); // 4
```

## Symptom

- V8: `1\n2\n3\n4`
- js2wasm: `1\n2\n1000002\n3`

This is not a simple off-by-one: `1000002` is a value that never appears in
the correct trace at all, suggesting the two generator instances (`g1`,
`g2`) are not correctly sharing the single `total` ref-cell from the
enclosing `makeCounter` closure — likely each generator instance is getting
its own copy of (or a corrupted pointer into) the captured variable state
rather than sharing the one mutable cell, and/or generator-local state and
closure-captured state are aliasing incorrectly across the two live
instances. **Flag as correctness-sensitive**: this is a case where two
independently-advancing generator objects share mutable closure state, a
pattern real code (iterator adapters, shared-counter utilities) can hit.

## Repro file

`tests/differential/corpus/generators/06-closure-state.js` (see #3683).
