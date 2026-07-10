---
id: 2804
title: "host path: object spread `{...a}` & Object.assign drop copied values/keys (closed-struct representation mismatch)"
status: done
assignee: ttraenkler/sendev-objspread
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
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

## Implementation notes (resolved 2026-06-28, sendev-objspread)

Root-caused both halves to a **representation/path mismatch**, not the
hypothesised host-mirror gap. Fix keys on the **TS type / chosen representation**,
never the Wasm kind.

### A — spread `{ ...a, z: 3 }` (wrong key order + NaN values)

The `#2714` routing already sent a spread literal in a NON-SPECIFIC context (no
contextual type — exactly `const b = { ...a, z: 3 }`) to the host plain-object
(`$Object`/externref) path. But the **variable** `b`'s slot was still typed as the
struct TypeScript *infers* (`{z;x;y}`): the host `$Object` was then `ref.test`/
`ref.cast` to that struct at runtime, the cast **failed**, `b` became null →
`b.x`/`b.z` read NaN/null. And `Object.keys(b)` took a **compile-time struct-shape
fast path** that lists the inferred field order (`z,x,y`, own-prop-first), not the
spread's runtime CopyDataProperties **insertion order** (`x,y,z`).

Fix — make the local/global representation follow the routing decision:
- Extracted the routing predicate as `objectLiteralSpreadTakesHostPath`
  (`literals.ts`) — the single source of truth.
- Force an **externref** slot (+ `externrefAccessorVars` tag) for a host-path
  spread initializer at **all four** variable-typing sites that pre-date
  `compileVariableStatement`: `statements/variables.ts`, the var-hoist and the
  authoritative `walkStmtForLetConst` TDZ pre-hoist in `index.ts`, and the
  module-global typer `moduleInitForcesExternref` in `declarations.ts` (top-level
  `const` becomes a global, NOT a function local — this was the one that kept the
  corpus failing after the first three were fixed).
- `Object.keys`/`values`/`entries` of an `externrefAccessorVars` var → route to
  the runtime `__object_*` helper (`object-ops.ts`) so enumeration reflects the
  live host object's insertion order, not the struct shape.
- An explicit concrete-struct annotation pins a contextual type → predicate false
  → struct path retained (#2714 control stays green).

### B — `Object.assign(t, { b }, { c })` (sources dropped from keys)

NOT a copy failure: the host `__object_assign` already copies source keys into the
struct target's **sidecar** (for-in surfaced `a,b,c`). But the copy is a plain
dynamic write recording **no descriptor**, and `__object_keys`/`values`/`entries`/
`getOwnPropertyNames` only surface sidecar keys on a struct that carry a descriptor
(`#2746`) — so `Object.keys` dropped them while for-in showed them (an existing
keys-vs-for-in inconsistency). Fix: in `__object_assign` (`runtime.ts`, host),
record an enumerable writable+configurable descriptor for each newly-copied
non-static-field key — matching the spec data-property semantics Object.assign's
`[[Set]]` creates, and making all four enumeration helpers consistent with for-in.

### Validation

- `object/02-spread` + `object/12-assign` now MATCH V8; full diff-test corpus
  **+2 match / 0 regress** (94/104, object 11/12 — the lone remaining `06-delete`
  is a pre-existing delete-on-struct issue, untouched here).
- Host **and** standalone both correct (the runtime.ts change is host-only;
  standalone uses the native `object-runtime.ts` `__object_assign` + native
  `$Object`, which already passed — **no new unconditional standalone helper**, so
  the #2097 floor is unaffected).
- Green: `#2714` (11), `#2746` (14), `#2076`, `#1336`, `#1630`, `#2011`, `#1239`,
  `#2127`, `#1901`, `#786`; `tests/issue-2804.test.ts` 20/20 (host+standalone);
  `tsc` clean. The 9-file object/spread batch is byte-identical pass/fail to clean
  `main` (the `spread-rest.test.ts` `string_constants`-harness failures are
  pre-existing and 100% reproduce on `main`, not in any CI gate).
