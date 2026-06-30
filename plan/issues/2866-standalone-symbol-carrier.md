---
id: 2866
title: "Standalone: Symbol values leak __box_symbol — no Wasm-native Symbol carrier"
status: done
assignee: ttraenkler/sendev-symbol
created: 2026-06-30
updated: 2026-06-30
completed: 2026-06-30
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

| probe                                       | result                                           |
| ------------------------------------------- | ------------------------------------------------ |
| `o[s]=42; o[s]===42`                        | RUNERR `illegal cast`, leaks `env::__box_symbol` |
| `Object.getOwnPropertySymbols(o)`           | RUNERR `illegal cast`, leaks `env::__box_symbol` |
| `{[Symbol.toPrimitive](){return 7}}` (o\*1) | RUNERR `illegal cast` (no import)                |

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

## Design decision (2026-06-30)

Design **(A) union/eqref key** chosen; **(B) rejected** — a collision risk in the
shared `$Object` key channel is a substrate hazard not worth the speed (coordinator
sign-off). Carry as a multi-PR incremental effort (self), verify-first that
standalone string-keyed ops stay behavior-identical at each slice (the key channel
is every property op — high blast radius). Note: `$Object`/`$PropEntry` are
standalone/wasi-only (host `gc` uses `env::__extern_*`), so host mode is
structurally untouched; the no-regression bar is the standalone string-key suite.
Slice order: (1) native `$Symbol` struct + standalone native `__box_symbol`; (2)
eqref key-channel widening (find/store/has/delete) behind ref.test branch; (3)
enumeration split (Object.keys excludes / getOwnPropertySymbols selects); (4)
Symbol.toPrimitive dispatch.

## Implementation — PR1 (slices 1+2 + enumeration EXCLUSION), sendev-symbol 2026-06-30

**Why these three land together (and why the blast radius is smaller than feared).**
Verify-first re-confirmed on this branch's base: a standalone Symbol VALUE is a
bare **i32 counter id** (not a struct) with its description in the id→string side
table (`symbol-native.ts`); the simple surface (`typeof`, identity, `Symbol.for`,
well-known `===`, `.description`) already works host-free. The ONLY gap is a
Symbol as an `$Object` **key** (`o[sym]=v`), which leaked `env::__box_symbol` and
then trapped `illegal cast` at the `(ref $AnyString)` key path.

Two findings collapsed the change to a contained set:

- **`$Object`/`$PropEntry` are standalone/wasi-ONLY.** Empirically: gc/host mode
  never registers `$PropEntry` (host `env::__extern_*` own dynamic props), and
  closed-shape typed objects use `struct.get`. So **host mode is structurally
  untouched** — the "thousands of string-key tests" in gc mode are byte-identical
  by construction. The no-regression bar is the standalone string-key suite.
- Most `$PropEntry.key` readers feed `extern.convert_any` (which accepts `anyref`)
  or read from `__obj_ordered`'s compacted output — so widening the key field to
  `anyref` and **excluding `$Symbol` keys inside `__obj_ordered`/`_all`** cleans up
  every enumeration consumer (`Object.keys`/`values`/`entries`/`getOwnPropertyNames`/
  for-in/JSON) with no per-site edits. `__object_assign` re-sets via `__extern_set`,
  so it copies symbol keys correctly for free. `__to_property_key` already passes a
  `$Symbol` through (its object-arm gates on `ref.test $Object`).

So enumeration-exclusion is **not optional** in PR1: once a `$Symbol` can be stored
in the map, `Object.keys`/JSON must skip it (§10.1.11.1) or they'd mis-render — that
is why slices 1+2 are inseparable from the string-enumeration guard.

**Design A (signed-off) as built.** `$PropEntry.key : (ref $AnyString)` → `anyref`
(holds `$AnyString` OR a native `$Symbol`). Identity is by the i32 `$Symbol.$id`
(id-compare), **not `ref.eq`**, so the carrier needs **no interning** — `__box_symbol`
builds a fresh struct each call; two carriers with the same id compare equal. `anyref`
(not `eqref`) keeps storage free (the converted key and both key kinds widen to it).

Change set (all gated `ctx.standalone || ctx.wasi`; `symbolKeysEnabled` compile-time
guard so the string-only path is unchanged when symbols are absent from the type space):

- `symbol-native.ts` `ensureSymbolCarrier`: `$Symbol {id:i32, desc:(ref null $AnyString)}`
  struct + native `__box_symbol(i32)->externref` (DEFINED func, no import/no index shift).
- `expressions/late-imports.ts` + `type-coercion.ts`: route `__box_symbol` to the native
  carrier under no-JS-host mode (was the `env::__box_symbol` leak / number-box corruption).
- `object-runtime.ts`: widen `$PropEntry.key`→`anyref`; symbol-aware `__obj_hash` (id-hash
  branch); new `__key_equals(anyref,i32,i32,ref_null $NativeString)` (single equality used
  by find+insert — string hot path keeps one precomputed `__str_equals`); `__obj_find` +
  `__obj_insert` classify the search key once and store the raw key; `__obj_ordered`/`_all`
  exclude `$Symbol` keys from string enumeration (+ a safe `ref.cast $AnyString` at the
  index-of-key read).

**Verified host-free (`--target standalone`, 0 imports):** `o[sym]=v;o[sym]`,
overwrite, distinct symbols stored+read, same-symbol identity read-back, string+symbol
keys coexisting, `s in o`, `delete o[sym]`, `Object.keys`/`getOwnPropertyNames` EXCLUDE
the symbol, a well-known symbol as key. Standalone string-key ops (has/delete/values/
entries/assign/getOwnPropertyNames/JSON/grow/rehash) unchanged. gc-mode object+symbol
programs compile with NO `$Symbol` in the module (host path intact). (`o[a]+o[b]` reads
0 only because `any+any` arithmetic is a separate pre-existing standalone gap — the
string-key `o["a"]+o["b"]` reads 0 too; `(.. as number)+(.. as number)` gives the right
answer.)

**Deferred to follow-ups (pre-existing gaps, NOT regressions):**

- ~~slice 3 SELECT side~~ **DONE (sendev-promisecarrier, 2026-06-30).** See
  "## Implementation — slice 3" below.
- slice 4 — `Symbol.toPrimitive` dispatch in the coercion engine (ties into #2862).

## Implementation — slice 4 (Symbol.toPrimitive STRING-hint dispatch), sendev-symbol 2026-06-30

**Verify-first re-grounded the gap (the earlier "illegal cast" finding was stale).**
On current `origin/main` (post-PR1 #2377 + the #2891 ToPrimitive-operators landing),
the NUMBER-hint path already dispatches `[Symbol.toPrimitive]` host-free: `+o` /
`o*1` return the right value via `coerceType(ref→f64, "number")` →
`${name}_@@toPrimitive`. The remaining gap was the **STRING-hint** coercion
contexts — a template-literal span `` `${o}` `` and `String(o)` — which did NOT
dispatch the well-known method:

- **Template literal** → `tryStructToString` (type-coercion.ts), which only checked
  a `toString` field/`${name}_toString` and fell through to `$__any_to_string`
  ("[object Object]"). `[Symbol.toPrimitive]` was explicitly deferred there (old
  doc comment).
- **`String(o)`** → `coerceType(ref→externref, "string")` already dispatched
  `${name}_@@toPrimitive`, but for a **numeric** result it `__box_number`-boxed the
  number and returned the _boxed number_ as the "string" — which then null-derefs
  on the next string op (`String(o).length`).

**Fix (standalone/native only; gc structurally untouched):**

1. `tryStructToString` (type-coercion.ts): add a §7.1.1.1-precedence `@@toPrimitive`
   arm BEFORE the `toString` lookup — push the `"string"` hint, call
   `${name}_@@toPrimitive`, then normalise the result to a `ref $AnyString`. A
   numeric (f64/i32) result is ToString'd via the native `number_toString`
   formatter (registered on demand — `emitNativeNumberFormat` only APPENDS defined
   funcs, **no import-insert → no funcIdx-shift hazard**). This is preferred over
   `normaliseToString`'s `__box_number`→`$__any_to_string` route, whose boxed-number
   arm is OMITTED when `number_toString` was absent at the (cached) helper's build
   time (an object-only program never registers it → "[object Object]").
2. `coerceType(ref→externref)` `@@toPrimitive` arm: under a **STRING hint** (and
   `ctx.nativeStrings`), ToString a numeric result via `number_toString` (returns
   an externref wrapping a native string) instead of `__box_number`. **Gated on
   `ctx.nativeStrings`** so gc mode keeps the exact prior `__box_number` branch —
   byte-identical (verified: gc `String(o)` WAT still calls `__box_number`).

**Verified host-free (`--target standalone`, 0 imports):** `` `${o}` `` /
`String(o)` dispatch `[Symbol.toPrimitive]("string")` for both string- and
number-returning methods (`String(o).length` correct); class `[Symbol.toPrimitive]`
in string context; `+o` number-hint unchanged; toString-only + valueOf + plain
`[object Object]` objects unregressed. 20/20 in `tests/issue-2866.test.ts`; related
toprimitive/string-coercion suites green (#1716, #1806, #2163, #1470, #2610, #1732,
#2891, #2358-nominal, #2638, #1917). gc byte-unchanged by construction (native-gated).

**Side-benefit + a known minor edge (NOT a regression):** the native `+`-concat
path (`obj + str`) also routes objects through `tryStructToString`, so it now
dispatches `[Symbol.toPrimitive]` too — a strict improvement over the prior
"[object Object]" (which ignored the method entirely). Its hint is `"string"`
rather than the spec's `"default"` for `+`; this only differs for the rare method
that distinguishes `default` vs `string`, and the prior behaviour was already
wrong, so it is net-positive. Threading the exact `"default"` hint through
`tryStructToString`'s callers is a follow-up. **Not addressed (separate gates):**
abstract `==` ToPrimitive dispatch; `obj + str` default-hint `valueOf`-only
(pre-existing native-concat gap, unrelated to symbols).

## Implementation — slice 3 (getOwnPropertySymbols SELECT side), 2026-06-30

`Object.getOwnPropertySymbols(o)` now returns the object's own symbol keys
host-free (was the `[]` stub). Three coordinated pieces:

1. **`object-runtime.ts` — `__obj_ordered_symbols` + real `__getOwnPropertySymbols`.**
   The SELECT counterpart to PR1's string-key EXCLUSION: a new
   `__obj_ordered_symbols(ref $Object) -> ref $PropMap` compacts the LIVE own
   `$Symbol`-keyed entries (INCLUDING non-enumerable — §20.5.2.9 returns all own
   symbol keys) and selection-sorts them by `$PropEntry.seq` (insertion order;
   symbols are never integer indices, so NO `entryIndexOf`/`ref.cast $AnyString`
   which would trap on a `$Symbol` key). `__getOwnPropertySymbols` (under
   `symbolKeysEnabled`) walks that compacted map and pushes each stored `$Symbol`
   carrier (`extern.convert_any(e.key)`) into a fresh `$ObjVec`; the `[]`-stub is
   kept for host/gc mode and symbol-free modules (byte-identical).

2. **`symbol-native.ts` — INTERN `__box_symbol` carriers by id.** A standalone
   symbol VALUE is a bare i32 id, but every externref crossing (object key,
   `symbol[]` element, an `any`-typed arg like `assert.sameValue(syms[0], sym)`)
   boxes it via `__box_symbol`. The generic externref `===` paths
   (`__extern_strict_eq`/`__any_strict_eq`, array `indexOf`) compare boxed objects
   with `ref.eq`, so a fresh struct per box made two boxings of the SAME symbol
   unequal (broke `getOwnPropertySymbols` identity, `sym in obj`,
   `[sym].indexOf(sym)`). A growable id→carrier intern table makes `ref.eq` hold
   for same-id boxings — symbol identity now works uniformly with **no change to
   the central equality helpers**.

3. **`type-coercion.ts` — carrier → i32-id unbox.** For the symbol-TYPED path
   (`let s2: symbol = syms[0]`, whose value-position rep is the i32 id), both the
   scalar `externref → i32` coercion and the typed-vec element materialization
   (`buildElemCoerce`) recover `$Symbol.id`. The vec path runtime-dispatches
   (`ref.test $Symbol` → id, else `__unbox_number`) because `symbol[]` shares the
   unbranded `$__arr_i32` element type with `number[]` and can't be disambiguated
   statically. All gated on the carrier being registered → byte-identical for
   symbol-free / host modules.

All gated on `symbolKeysEnabled` / `ctx.symbolTypeIdx >= 0`; zero host imports.
Verified: 7 new standalone tests in `tests/issue-2866.test.ts` (length, identity,
re-index, insertion order, string-key disjointness, empty, any-boundary `===`);
the `built-ins/Object/getOwnPropertySymbols` standalone dir improves (the
remaining fails are Proxy-dependent / ToObject-coercion / not-a-constructor —
separate concerns). The full merge_group standalone report is the conformance
gate.
