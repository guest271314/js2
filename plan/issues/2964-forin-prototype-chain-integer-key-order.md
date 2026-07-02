---
id: 2964
title: "for-in on $Object: prototype-chain enumeration + integer-key-ascending ordering"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
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
