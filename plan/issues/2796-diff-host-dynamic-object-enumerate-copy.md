---
id: 2796
title: "diff-test host path: dynamic-object own-key enumerate/copy — for-in empty, spread loses values, Object.assign loses keys"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: objects
goal: trustworthiness
related: [2787, 1243, 1271, 1336, 1630]
origin: "2026-06-28 — #2787 differential-corpus triage (cluster A2)"
---

# #2796 — Host-path dynamic-object own-key enumeration & copy

## Problem (cluster from #2787 diff-test triage)

Three idiomatic object programs fail in the default WasmGC + JS-host path. All
three depend on **enumerating + reading the own enumerable string keys of a
dynamically-built object literal**, and that path drops keys and/or values.

### A — `for...in` over an object yields nothing

`tests/differential/corpus/control/12-for-in-object.js`

```js
const o = { a: 1, b: 2 };
const keys = [];
for (const k in o) keys.push(k);
console.log(keys.sort().join(",")); // V8: a,b   js2wasm: "" (empty)
```

Existing issue #1243/#1271 (for-in / Object.keys enumeration) are marked `done`
but this corpus case **regresses or is uncovered** in the host path.

### B — object spread `{ ...a }` wrong key order + values become NaN

`tests/differential/corpus/object/02-spread.js`

```js
const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };
console.log(Object.keys(b).join(",")); // V8: x,y,z   js2wasm: z,x,y  (wrong order)
console.log(b.x); // V8: 1       js2wasm: NaN    (value dropped)
console.log(b.z); // V8: 3       js2wasm: NaN
```

`Object.keys(b)` returns the keys (so spread does populate the bag), but in the
**wrong insertion order** and with the **copied values lost** (read back as NaN).

### C — `Object.assign` copies no keys

`tests/differential/corpus/object/12-assign.js`

```js
const t = { a: 1 };
const r = Object.assign(t, { b: 2 }, { c: 3 });
console.log(Object.keys(r).join(",")); // V8: a,b,c   js2wasm: "" (empty)
console.log(r === t); // V8: true    js2wasm: true ✓
```

Identity is preserved (`r === t`) but no own enumerable keys are copied from the
sources. Existing issue #1336/#1630 (Object.assign getters/Symbol keys) `done`
but the basic data-property copy **regresses or is uncovered** here.

## Repro

```bash
FORCE_COLOR=0 npx tsx scripts/diff-test.ts   # control/12, object/02, object/12 mismatch
```

## Root cause (hypothesis)

A shared "iterate own enumerable string keys of a dynamic object + read each
value" primitive is incomplete in the host path:

- enumeration order is not insertion order (spread reorders),
- value read-back returns NaN (the boxed value is not recovered),
- the for-in / Object.assign source-enumeration walks zero keys.

Likely centred on the dynamic-object (`$Object` / property-bag) representation
and its key-iteration + value-get helpers. Fixing the shared primitive should
flip all three together.

## Acceptance criteria

- `control/12-for-in-object.js`, `object/02-spread.js`, `object/12-assign.js`
  all match V8 in `scripts/diff-test.ts`.
- Own enumerable string keys enumerate in insertion order; spread/assign copy
  both keys **and** values.

## Notes

- High-value: object spread / assign / for-in are core ES2015+ idioms; this
  cluster also likely covers many test262 object cases. The "done" status of
  #1243/#1271/#1336/#1630 vs the corpus failure suggests these were validated on
  a narrower path (typed objects / specific test262 shapes) than the idiomatic
  untyped object literals the corpus uses — confirm regression vs current main.
