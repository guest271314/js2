---
id: 2804
title: "host path: object spread `{...a}` & Object.assign drop copied values/keys (closed-struct representation mismatch)"
status: ready
sprint: current
created: 2026-06-28
updated: 2026-06-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: objects
goal: trustworthiness
related: [2796, 2787, 1336, 1630]
origin: "2026-06-28 — carved from #2796 (diff-test host enumerate/copy). Spread/assign cases are a real codegen bug, NOT the exports-timing one #2796 fixed."
horizon: m
---

# #2804 — Host object spread `{...a}` & `Object.assign` lose copied values/keys

## Problem (carved from #2796 cluster A2)

#2796's `for…in` case was a HARNESS exports-timing artifact (top-level
enumeration ran before `setExports` wired the struct-introspection exports),
fixed by `deferTopLevelInit` (the host diff-test lane now runs top-level code
after `setExports`, symmetric with the standalone `_start` model). But two of
the three corpus programs in that cluster are a SEPARATE, genuine codegen bug:
they stay broken even when the program is run with the runtime FULLY wired
(verified by running the body inside an exported `test()` called after
`setExports`, and by the `deferTopLevelInit` diff-test path):

### A — object spread `{ ...a, z: 3 }`: wrong key order + values read back as NaN

`tests/differential/corpus/object/02-spread.js`

```js
const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };
console.log(Object.keys(b).join(",")); // V8: x,y,z   js2wasm: z,x,y  (wrong order)
console.log(b.x); // V8: 1       js2wasm: NaN  (value dropped)
console.log(b.z); // V8: 3       js2wasm: NaN
```

`Object.keys(b)` returns all three keys (so the spread populates SOME bag), but
in the wrong insertion order, AND a later `b.x` read returns NaN. Hypothesis:
the spread result `b` is built as a dynamic `$Object` / property bag (with `z`
pushed before the spread-copied `x`,`y`), but TS narrows `b` to the closed
struct type `{x:number;y:number;z:number}`, so `b.x` compiles to a struct field
read against a value that is NOT that struct → reads garbage / NaN. A
representation mismatch between the spread's runtime shape and the static type.

### B — `Object.assign(target, ...sources)` copies no source keys

`tests/differential/corpus/object/12-assign.js`

```js
const t = { a: 1 };
const r = Object.assign(t, { b: 2 }, { c: 3 });
console.log(Object.keys(r).join(",")); // V8: a,b,c   js2wasm: a  (sources dropped)
console.log(r === t); // V8: true    js2wasm: true ✓
```

Identity is preserved (`r === t`) and the target's own key (`a`) survives, but
the source objects' keys (`b`, `c`) are not copied. The sources are closed-struct
literals; the host `__object_assign` mirror (`_wrapForHost` + `Object.assign`)
does not surface their own enumerable data properties for the copy (even with
exports wired). Cf. #1336/#1630 (Object.assign getters/Symbol keys) which were
validated on a narrower path than these idiomatic untyped literals.

## Repro

```bash
FORCE_COLOR=0 npx tsx scripts/diff-test.ts   # object/02-spread, object/12-assign mismatch
```

## Root cause (hypothesis)

Object spread and `Object.assign` over closed-struct operands in the JS-host
path do not faithfully copy own enumerable string keys + values:

- spread builds a `$Object` whose key order is not insertion order and whose
  copied values are not recoverable through the static closed-struct read path;
- `Object.assign`'s host mirror does not enumerate the source closed-structs'
  own data properties.

The `compileObjectAssignArg` `$Object` diversion (calls.ts) is standalone-only —
the JS-host path keeps closed-struct operands. Likely needs the host
`__object_assign` mirror to enumerate struct fields for sources, and the spread
lowering to either build a closed struct (so the typed read matches) or keep the
read on the dynamic path.

## Acceptance criteria

- `object/02-spread.js` and `object/12-assign.js` match V8 in `scripts/diff-test.ts`.
- Object spread copies both keys (insertion order) and values; `b.x`/`b.z` read back.
- `Object.assign` copies own enumerable data properties from all sources.

## Notes

- Carved from #2796. #2796 fixed the `for…in` enumeration-timing case; this is
  the residual real codegen representation bug.
