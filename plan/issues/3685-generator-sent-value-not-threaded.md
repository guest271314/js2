---
id: 3685
title: "Generator two-way yield: value passed to .next(x) is not threaded back into the generator body"
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
origin: "#3683 — new tests/differential/corpus/generators/04-sent-values.js surfaced this on first run"
related: [3683]
---

# #3685 — `x = yield y` does not receive the value passed to `.next(x)`

## Repro

```js
function* echo() {
  let received = [];
  let x = yield "ready";
  while (x !== "stop") {
    received.push(x);
    x = yield received.length;
  }
  return received;
}
const g = echo();
console.log(g.next().value); // "ready"
console.log(g.next("a").value); // 1
console.log(g.next("b").value); // 2
const last = g.next("stop");
console.log(last.value.join(",")); // "a,b"
console.log(last.done); // true
```

## Symptom

- V8: `ready\n1\n2\na,b\ntrue`
- js2wasm: `ready\n1\n2` then a runtime error `join is not a function` on
  the 4th line.

The `1` and `2` outputs happen to be right (since `received.length` only
depends on the push count, not the value), but `received` itself does not
actually contain `["a", "b"]` — the final `.join(",")` fails, meaning `x`
(the value bound from `yield "ready"` / `yield received.length`) is not
being correctly assigned from the argument passed to `.next()`, so
`received.push(x)` is pushing something that isn't a string (or `received`
itself is wrong). This is the two-way generator communication protocol
(`x = yield y`), separate from simple `yield`-only generators which already
work (see #3683's `01-basics.js`/`02-for-of.js`, both matching).

## Repro file

`tests/differential/corpus/generators/04-sent-values.js` (see #3683).
