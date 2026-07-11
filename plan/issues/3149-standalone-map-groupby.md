---
id: 3149
title: "standalone: Map.groupBy (12 __get_builtin CEs)"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984, 2162, 2863]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3149 — standalone Map.groupBy

## Problem

`Map.groupBy(items, callback)` used standalone hard-CEs through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **12** non-pass
standalone entries under `built-ins/Map/groupBy/`. (Object.groupBy is a
sibling; check whether it clusters here too and fold it in if so.)

## Sample paths

- `test/built-ins/Map/groupBy/negativeZero.js`
- `test/built-ins/Map/groupBy/callback-throws.js`
- `test/built-ins/Map/groupBy/invalid-callback.js`
- `test/built-ins/Map/groupBy/map-instance.js`

## Shared-infra deps

- Needs `Map.groupBy` as a resolvable standalone builtin: iterate the iterable,
  call the callback per element, `CanonicalizeKeyedCollectionKey` (the -0→+0
  normalization the `negativeZero.js` test asserts), and append into a Map
  keyed by the callback result. Reuses the standalone Map runtime (#2162) +
  the iterator-protocol substrate. Small (12 tests, S) — good tail-filler.
  The `groupBy` grouping helper (`#2863` groupBy landed for arrays?) may share
  code — check before implementing.

## Acceptance

- `built-ins/Map/groupBy/*` standalone tests compile + pass with 0
  regressions.
