---
id: 2620
title: "Standalone `class X extends Set/Map` — synthetic accessor late-import index-shift (-1 global) + host-import leak"
status: ready
sprint: Backlog
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: collections
language_feature: Set, class
goal: standalone-mode
parent: 2162
depends_on: 2043
---

# #2620 — Standalone subclass-of-native-collection compile errors (split from #2606 Bug B)

Split out of #2606 (Bug A — null/undefined element coercion — landed; this is the
deeper, higher-risk Bug B the spec flagged as routable to the index-shift owner).

## Symptom

```
L2:1 Binary emit error: Codegen error: global index out of range — -1
(valid: [0, 10)) at function 'MySet_size'. This is the late-import index-shift
class (#2043): a captured index went stale across a deferred
flushLateImportShifts/addUnionImports/addStringImports shift…
```
from
```js
class MySet extends Set {
  size(...rest) { return super.size(...rest); }
  has(...rest)  { return super.has(...rest); }
  keys(...rest) { return super.keys(...rest); }
}
const s1 = new MySet([1, 2]);
s1.isSubsetOf(new Set([2, 3]));
```

`test/built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
isSubsetOf,isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js` (~7 rows).

## What was confirmed (2026-06-22 — dev-collections)

This is **two intertwined defects**, both substrate-deep:

1. **Host-import leak.** Even a *bare* `class MySet extends Set {}` in standalone
   mode leaks `env::Set_new` / `env::Set_add` / `env::Set_has` host imports
   (`WebAssembly.instantiate(): Import #0 "env" …`). The subclass-of-native-
   collection construction path does NOT route through the WasmGC-native Set
   runtime — it falls to the externClass host path. A standalone subclass needs
   a native `extends $Map`-backed instance.
2. **`-1` global index** in the synthetic `<Class>_<method>` accessor body. Only
   the exact `size(...rest) { return super.size(...rest); }` + `has` + `keys`
   combination triggers it (a `-1` global.get/set baked by a late-import shift
   that the synthetic-accessor table is not shifted in lockstep with). This is
   the #2043 family — `addUnionImports`/`flushLateImportShifts` reorders the
   import/global table after the synthetic accessor's index was captured.

## Direction (for the index-shift / value-rep owner)

- Route `extends Set`/`extends Map`/`extends WeakMap`/`extends WeakSet` to a
  native `$Map`-backed instance in standalone (no `env::Set_*` host imports), the
  way #2162 made the base collections native.
- Apply the #2162 `mapHelpers`-shift lockstep discipline to the subclass-accessor
  index table: add it to every `addUnionImports`/`shiftLateImportIndices` site, or
  defer its registration until AFTER the collection runtime + box helpers are
  registered. Re-resolve by name after the last shift.
- Fallback if the machinery stays entangled: make `extends Set`/`extends Map` a
  *clean* compile error (not invalid-Wasm) so it never poisons the binary — but
  prefer the real native fix (the rows expect the subclass to work).

## Not in scope here

The ~21 instanceof/sameValue-bool rows (#2605) and the ~7 null/undefined element
rows (#2606 Bug A) are already fixed and merged separately.
