---
id: 3689
title: "Private brand check (#x in obj) on a null receiver does not throw a catchable TypeError"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: low
horizon: s
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: n/a
goal: property-model
origin: "#3683 — new tests/differential/corpus/private-fields/05-brand-checks.js surfaced this on first run"
related: [3683]
---

# #3689 — `#field in obj` with `obj === null` should throw a catchable TypeError

## Repro

```js
class Box {
  #v;
  constructor(v) { this.#v = v; }
  static isBox(obj) { return #v in obj; }
}
const b = new Box(1);
console.log(Box.isBox(b));   // true
console.log(Box.isBox({}));  // false
try {
  Box.isBox(null);
} catch (e) {
  console.log(e instanceof TypeError); // true
}
```

## Symptom

- V8: `true\nfalse\ntrue`
- js2wasm: `true\nfalse` (third line never printed)

The first two brand-check cases (own instance → `true`, unrelated plain
object → `false`) already match — see #3683's `private-fields/01-fields.js`
through `04-accessors.js`, all matching. Per spec, the ergonomic
brand-check form `#x in obj` must return `false` for any non-`Box`
*object*, but throw a `TypeError` when `obj` is not an object at all (e.g.
`null`/`undefined`/a primitive). js2wasm appears to either trap
uncatchably or silently swallow the case rather than raising a JS-catchable
`TypeError`, so the `try`/`catch` never logs its line — worth checking
whether this shares a root cause with other brand-check-vs-uncatchable-trap
issues (`tests/issue-private-access-brand.test.ts` fixed an analogous
`.call(nonInstance)` case).

## Repro file

`tests/differential/corpus/private-fields/05-brand-checks.js` (see #3683).
