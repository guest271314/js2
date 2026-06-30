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

## Verify-first findings + implementation spec (sendev-promise, 2026-06-30)

**Current state (probed on origin/main, `--target standalone`).** A Symbol is an
**i32 counter id** (`{kind:"i32", symbol:true}`) — NOT a struct. The SIMPLE cases
already work host-free and correct (`result.imports` empty, return 1):
`typeof s==="symbol"`, distinct-identity (`Symbol("x")!==Symbol("x")`),
`Symbol.for` interning, well-known `===`, `.description`.

**The real gaps (host-free FAILS), all rooted in one thing — Symbol-as-an-`$Object`-key:**

| probe | result |
|---|---|
| `o[s]=42; o[s]===42` | RUNERR `illegal cast`, leaks `env::__box_symbol` |
| `Object.getOwnPropertySymbols(o)` | RUNERR `illegal cast`, leaks `env::__box_symbol` |
| `{[Symbol.toPrimitive](){return 7}}` (o*1) | RUNERR `illegal cast` (no import) |

Root cause: to enter the `$Object` property map a key must be an externref, and a
Symbol i32 is boxed via `env::__box_symbol` — a **host-only** import
(`index.ts:10386 addImport("env","__box_symbol")`; the "native standalone
`__box_symbol` exists" comments in property-access.ts are aspirational — it does
NOT). Worse, `$PropEntry.key` is typed **`(ref $AnyString)`** (object-runtime.ts
~208), so even a boxed Symbol can't be stored as a key without widening the
channel. So this is a **value-representation build**, not a gate-broaden.

### Required pieces (L, needs the value-rep call)

1. **Native `$Symbol` carrier struct** — `struct $Symbol { id:i32, desc:(ref null $AnyString) }`,
   registered once; standalone `__box_symbol(i32)->externref` becomes an in-module
   func building/interning a `$Symbol` (identity via the i32 id; `ref.eq` on the
   interned struct also works). Well-known symbols + `Symbol.for` registry already
   have stable ids — intern their `$Symbol` carriers as singletons.
2. **`$Object` key channel widening** — two options:
   - **(A) union key (correct, larger):** `$PropEntry.key : eqref` (or a
     `$AnyString | $Symbol` union), find-loop compares `$Symbol` keys by `id`/`ref.eq`
     and `$AnyString` keys by `__str_equals` (branch on `ref.test`). Touches
     `__to_property_key`, store/find/has/delete, enumeration. ~the whole key path.
   - **(B) encoded-key compile-away (smaller, collision-risk):** keep
     `key:(ref $AnyString)`, encode a Symbol key as a reserved sentinel string
     embedding the id, set a new `FLAG_SYMBOL` (0x20) bit on the `$PropEntry`.
     `Object.keys`/for-in/JSON exclude `FLAG_SYMBOL` (like the existing
     `FLAG_INTERNAL` 0x10 exclusion); `getOwnPropertySymbols` selects only
     `FLAG_SYMBOL` entries and decodes the id back to the `$Symbol`. Avoids the
     struct-type rewrite but needs a collision-proof sentinel and id↔desc decode.
   **Recommendation:** (A) is the durable design and aligns with the issue's plan;
   (B) is a faster slice if a bulk win is needed sooner. Pick per value-rep review.
3. **`getOwnPropertySymbols`** — enumerate Symbol-keyed entries (filter by the
   key type (A) or `FLAG_SYMBOL` (B)), return `$Symbol` carriers.
4. **`Symbol.toPrimitive` dispatch** — `{[Symbol.toPrimitive](){…}}` illegal-casts
   today; the coercion engine must look up the well-known `$Symbol` key (ties into
   #2862 ToPrimitive). Likely the same key-channel widening unblocks it.

### Host-mode safety
JS-host (`gc`) keeps the `env::__box_symbol` path entirely — gate every native
carrier piece on `ctx.standalone || ctx.wasi`, mirroring the Promise/generator
carriers. Verify gc byte-unchanged.

### Acceptance
`result.imports` empty for `o[sym]`, `getOwnPropertySymbols`, `Symbol.toPrimitive`;
identity preserved (`Symbol("x")!==Symbol("x")`, well-known `===`); Symbol keys
excluded from `Object.keys`/for-in/JSON; zero host-mode regression; full
merge_group + honest standalone floor.
