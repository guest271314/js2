---
id: 3669
title: Property slot monomorphism — a slot seeded with a number/boolean corrupts on some later writes
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [2773, 2760, 2949, 3667, 3668]
assignee: ttraenkler/opus-loop-g
created: 2026-07-26
---

# #3669 — property slot monomorphism

## Problem

A property slot seeded with a **number** or **boolean** corrupts on _some_ later
writes of a different value kind. The read-back is a value that is **not equal
to itself** — the sNaN-like type-default sentinel #2760 already names.

```js
var o = {};
o.p = 1;
o.p = "unlikelyValue";
o.p === "unlikelyValue"; // false
typeof o.p; // "string"   <-- tag says string
o.p !== o.p; // true       <-- payload is sNaN
```

The tag and the payload disagree: `typeof` reports `"string"` while the stored
value behaves as sNaN. So this is not "the write was rejected" — the write
partially landed.

## Why it matters (reach bounds, NOT a flip count)

`propertyHelper.js:isWritable` decides writability by assigning the **string**
`"unlikelyValue"` over the property's current value and reading it back
(`isSameValue(obj[name], newValue)`). On a numeric property that read-back
fails, so `isWritable` returns `false` and `verifyProperty` reports
_"obj['p'] descriptor should be writable"_ on a perfectly ordinary property:

```js
var o = {};
o.p = 1;
verifyProperty(o, "p", { value: 1, writable: true, enumerable: true, configurable: true });
//   -> Test262Error: obj['p'] descriptor should be writable
```

**Bounds only:** 5,067 corpus tests call `verifyProperty`, and the `isWritable`
path runs in essentially every call that asserts `writable`. That is a ceiling
on reachability, **not** a predicted flip count — measure with
`scripts/harness-flip-probe.ts` (#3668) before quoting any number. The
circulating "~1,038" figure is unrelated and must not be reused.

## Characterisation (measured)

Through the real assembled harness on `upstream/main`, positive control on every
run, **reading verified deterministic** (byte-identical on repeat).
Reproducer: `scripts/fixtures/issue-3669-monomorphism/transitions.js`.

### Transition matrix — seed kind → overwrite kind

| seed \ write | number     | string     | boolean   | null       | undefined | object     |
| ------------ | ---------- | ---------- | --------- | ---------- | --------- | ---------- |
| **number**   | ok (ctrl)  | **BROKEN** | ok        | **BROKEN** | ok        | **BROKEN** |
| **string**   | ok         | ok (ctrl)  | ok        | –          | –         | ok         |
| **boolean**  | **BROKEN** | **BROKEN** | ok (ctrl) | –          | –         | –          |
| **object**   | ok         | ok         | –         | –          | –         | –          |

**5 of 12 cross-kind transitions are broken; 7 work.** All three same-type
controls pass.

**This is the key structural finding: the failure is selective, not uniform.**
It is _not_ one missing widening primitive — if slots simply could not widen,
`num→bool`, `num→undefined`, `str→*` and `obj→*` would fail too, and they do
not. Nor is it "numeric slots are frozen": `num→bool` succeeds while
`bool→num` fails, which is asymmetric. So the repair is a set of specific
transition lowerings in the value-rep substrate, not a one-line fix.

### Scope

- **Per-SLOT, not per-shape.** A sibling object built identically but only ever
  holding a string is unaffected (`shape-sibling:ok`). So this is the individual
  property slot's state, not a hidden class / shape transition.
- **Object-literal initialiser behaves exactly like assignment** —
  `{p: 1}` then `.p = "s"` breaks identically, while `{p: "a"}` then `.p = "b"`
  is fine. So the seeding happens at first _value_, wherever it comes from.
- **The slot does not recover.** A third, same-kind-as-the-second write
  (`o.p = 1; o.p = "s"; o.p = "t"`) still reads back wrong.
- The corrupted value is **self-unequal**, matching the "type-default sentinel
  (sNaN / `false` / `null`)" that #2760 describes for OOB array element reads.

## Adjacency — inherit, don't reinvent

This belongs to the **`value-rep-substrate` goal (#2773)**, not to
builtin dispatch:

- **#2760** (plain-array OOB → type-default sentinel) is the closest sibling:
  same class of defect (a slot's static Wasm type yielding a sentinel instead of
  the JS value), same sNaN signature. #2773 explicitly frames it as _"the
  element-read result needs an externref-or-undefined representation that
  ripples to every f64 consumer — a value-rep-shape decision, not a helper-flag
  flip."_ The same sentence applies here with "element-read" replaced by
  "property-slot read".
- **#2773** is the umbrella epic and asks the governing question directly:
  _what is the in-flight representation of a value as it crosses a
  dispatch/host/array boundary?_
- **#2949** would subsume this at the IR level (`{kind:"dynamic", tag?: JsTag}`),
  but is XL and not a prerequisite for a targeted repair.

**Lane note:** `value-rep-substrate` is Lane B (fable/porffor) under
`plan/method/lane-partition.md`. This issue was characterised in Lane A at the
tech lead's direction; the _implementation_ should be routed per the partition.

## What this is NOT

- Not the detached-builtin defect (#3667). That is a real but narrow bug —
  exactly one cell (`write-detached + read-direct`) — and its author measured
  their candidate fix as a **no-op**, then parked it. It cannot explain this:
  the reproducer above uses plain assignment, no `defineProperty`, no detached
  reference, no descriptor sidecar.
- Not explained by descriptor-sidecar enrichment. The prediction that failing
  `propertyHelper` tests would be enriched for `defineProperty`-defined
  properties was **measured and falsified** (#3668): 671 of 893 such tests pass.

## Suggested next step

1. Find where a property slot's Wasm type is chosen from its first assigned
   value, and what the write path does when a later value doesn't fit.
2. The asymmetry (`num→bool` ok, `bool→num` broken) is the sharpest lead — two
   adjacent transitions with opposite outcomes should localise the gap quickly.
3. Measure the fix with `scripts/harness-flip-probe.ts` (#3668), local-vs-local
   A/B. **Report zero flips as a result if that is what it measures.**

## Probe hazards (cost real time here)

Two probe shapes fail to compile for reasons unrelated to this defect. A
CompileError is not evidence:

- Wrapping each arm in `function () { …; return o.p === x; }` →
  `call[0] expected type externref, found if of type f64`. Arms must be inline.
- `if (d.writable === true)` on a descriptor field, and `"…" + err.message` in a
  `catch` → `if[0] expected type i32, found global.get of type externref`.
