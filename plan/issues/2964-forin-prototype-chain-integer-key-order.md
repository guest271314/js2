---
id: 2964
title: "for-in on $Object: prototype-chain enumeration + integer-key-ascending ordering"
status: done
assignee: ttraenkler/opus-2964
completed: 2026-07-02
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: low
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
language_feature: statements, objects
goal: standalone-mode
related: [2066, 1837, 2042, 2860]
origin: "2026-07-02 July Fable audit §3 dynamic-object-model gap (2)"
---

# #2964 — for-in enumerates own keys only, in pure insertion order

## Problem

Native for-in over dynamic receivers (`__object_keys`,
`src/codegen/statements/loops.ts:5884+`) enumerates **own** enumerable
keys in insertion order (`seq`, #1837) with delete-liveness (#2066). Two
spec gaps:

1. **No prototype-chain walk**: inherited enumerable properties are never
   visited (spec: own keys first, then proto chain, skipping shadowed and
   already-visited names, respecting enumerability at each level).
2. **Integer-key ordering unverified/likely wrong**: OrdinaryOwnPropertyKeys
   requires array-index keys first in ascending numeric order, then
   string keys in insertion order (then symbols — excluded from for-in).
   The pure-`seq` iteration order violates this whenever integer keys are
   inserted after string keys.

## Approach

- Extend the keys helper (or add `__object_keys_forin`): per-level
  own-keys pass = two-phase emit (numeric-ascending, then insertion-order
  strings), then walk `proto` links repeating with a visited-set (reuse
  the `$PropMap` probe for shadow checks — a visited list of already-yielded
  keys; sizes are small, O(n·chain) is fine).
- Enumerability re-checked at each level; tombstones + delete-liveness
  semantics preserved (a property deleted mid-loop before visit is
  skipped — keep the #2066 contract).
- Same helper feeds Object.keys ordering if it shares the fast path —
  verify Object.keys stays OWN-only.

## Acceptance criteria

- `for (k in Object.create({a:1}, {b:{value:2,enumerable:true}}))` visits
  b then a; shadowed and non-enumerable proto keys skipped.
- `{ b:1, 2:2, a:3, 0:4 }` enumerates `0,2,b,a`.
- test262 for-in cluster + language/statements standalone bucket
  net-positive; host mode unchanged where it uses the host path.

## Implementation (2026-07-02)

**Measure-first finding:** gap #2 (integer-key ascending) was **already
correct** on main — the standalone for-in path routes through `__object_keys`,
which delegates ordering to `__obj_ordered` (#1837, OrdinaryOwnPropertyKeys:
integer-index ascending then insertion order). A probe on current main returned
`02ba` for `{ b:1, 2:2, a:3, 0:4 }`. The only real gap was #1 — `__object_keys`
is OWN-only, so inherited enumerable keys were never visited (`for (k in
Object.create({a:1}))` yielded nothing from the proto).

**Fix** (`src/codegen/object-runtime.ts`, `src/codegen/statements/loops.ts`):
- New native `__object_keys_forin(externref) -> externref` ($ObjVec of keys).
  Per level (receiver → `$proto` → …, until null): yield the enumerable own
  keys (`__obj_ordered`) not already in a `seen` set, then add ALL own keys
  incl. non-enumerable (`__obj_ordered_all`) to `seen` so a closer-level own
  property shadows the same name deeper in the chain. `seen` is a scratch empty
  `$Object` (null `$proto`) used as a membership table via
  `__extern_has`/`__extern_set` — reusing the property map's exact key
  hashing/equality (no native-string representation mismatch).
- Standalone/WASI for-in over a dynamic receiver now routes `keysIdx` to
  `__object_keys_forin` instead of `__object_keys`. `Object.keys` still uses the
  OWN-only `__object_keys`. Host mode is untouched (uses the `__for_in_*` host
  imports, which proto-walk in JS).

## Test Results

`tests/issue-2964.test.ts` — 10/10 pass (standalone): proto-walk, both
acceptance examples (`ba`, `02ba`), own-shadows-proto dedup, non-enumerable
proto skip, non-enumerable-own shadow, count over a 2-level chain, Object.keys
own-only, empty object. Existing `issue-2572-standalone-forin` +
`issue-forin` (12 tests) still green. `tsc --noEmit` clean. **Host-mode binary
is byte-identical** base-vs-branch (sha256 `2bb8e092805430ae`, 2081 b) — the
new native is DCE'd when the standalone path is not taken, so the host lane is
fully inert.
