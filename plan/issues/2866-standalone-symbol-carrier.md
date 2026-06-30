---
id: 2866
title: "Standalone: Symbol values leak __box_symbol — no Wasm-native Symbol carrier"
status: ready
created: 2026-06-30
updated: 2026-06-30
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860]
umbrella: 2860
architect_spec: candidate
---

# Standalone: Wasm-native Symbol carrier

## Problem

Symbol creation/usage leaks the `env::__box_symbol` host import (and related
well-known-symbol machinery). Under standalone there is no JS host to box a
Symbol, so these tests fail/CE.

### Impact (measured 2026-06-30) — ~418 standalone-only failures

`__box_symbol` leaks in 950 gap tests (overlapping with other clusters); ~418
have Symbol as the dominant blocker (306 fail, 112 CE). Proximate errors include
`illegal cast [in __proxy_revoke() ← __closure]` where a Symbol-keyed access /
`Symbol.toPrimitive` / well-known symbol dispatch mis-resolves.

## Root cause

A Symbol is currently represented by boxing through the host (`__box_symbol`).
Standalone needs a native Symbol value representation:
- a nominal `$Symbol` struct carrying an optional description (native string) +
  a unique identity (the struct reference itself gives identity via `ref.eq` —
  cf. `reference_standalone_floor_object_identity_and_real_vs_drift`: native
  equality must preserve identity via `ref.eq`).
- well-known symbols (`Symbol.iterator`, `Symbol.toPrimitive`, `Symbol.asyncIterator`,
  `Symbol.hasInstance`, …) as interned singleton `$Symbol` globals.
- `Symbol.for`/`Symbol.keyFor` registry as a native map keyed by description.
- Symbol-keyed property storage: the `$Object` runtime must accept a `$Symbol`
  key (not just a native-string key) — extend the key normalization in
  `object-runtime.ts` (the `__extern_get`/`set`/`has` key path) to test
  `ref.test $Symbol` alongside `$AnyString`.

## Implementation Plan

**`architect_spec: candidate`** — value-representation design needed (interning,
identity, the `$Object` key-channel widening). Sketch:
- Define `$Symbol` struct + register interned well-known globals at module init.
- Route `typeof sym === "symbol"` to a `ref.test $Symbol` predicate
  (`__typeof_symbol`), replacing the `__box_symbol`-tag check.
- Widen the `$Object` property key channel to accept `$Symbol` keys with
  `ref.eq` identity comparison in the find loop (object-runtime.ts key dispatch,
  ~line 464 where `$AnyString`/`$BoxNum` keys are already handled).
- `Symbol.toPrimitive` lookup in the coercion engine must resolve the
  well-known `$Symbol` global key (ties into #2862 ToPrimitive).

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/Symbol/**`, `test/built-ins/Symbol/{for,keyFor,iterator,…}/**`
- `test/built-ins/Object/getOwnPropertySymbols/**`
- `test/built-ins/*/prototype/Symbol.toPrimitive/**`,
  `test/built-ins/*/*/Symbol.iterator/**`

Full `merge_group` + standalone high-water; preserve Symbol identity via
`ref.eq` (regression guard: two `Symbol("x")` must be `!==`, the same well-known
must be `===`). Zero host-mode regression.
