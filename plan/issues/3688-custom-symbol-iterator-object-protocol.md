---
id: 3688
title: "Plain object with a custom [Symbol.iterator]() method is not iterated correctly by spread/for-of"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: iterators
goal: iterator-protocol
origin: "#3690 — new tests/differential/corpus/builtins/19-symbol-iterator.js surfaced this on first run"
related: [3690]
---

# #3688 — Custom `[Symbol.iterator]()` on a plain object literal doesn't drive spread/for-of

## Repro

```js
const range = {
  from: 1,
  to: 3,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next() {
        return current <= last ? { value: current++, done: false } : { value: undefined, done: true };
      },
    };
  },
};
console.log([...range].join(","));
let total = 0;
for (const n of range) total += n;
console.log(total);
```

## Symptom

- V8: `1,2,3\n6`
- js2wasm: `0\n0`

Both the spread (`[...range]`) and `for-of` consumption produce empty/zero
results, as if `range` is treated as an empty iterable rather than invoking
the computed `[Symbol.iterator]()` method and driving its returned
`{next()}` protocol object. Built-in iterables (arrays, generator objects
per #3690's `generators/02-for-of.js`, which matches) already work — the
gap is specifically a **user-defined** iterable via a computed
`[Symbol.iterator]` method on an object literal.

## Repro file

`tests/differential/corpus/builtins/19-symbol-iterator.js` (see #3690).
