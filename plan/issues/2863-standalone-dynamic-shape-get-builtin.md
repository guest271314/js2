---
id: 2863
title: "Standalone: dynamic-shape object/property ops refused — __get_builtin (reflective builtin/namespace read), __extern_toLocaleString, __object_groupBy/fromEntries"
status: done
created: 2026-06-30
updated: 2026-07-03
completed: 2026-07-02
priority: high
feasibility: medium
task_type: feature
area: codegen
goal: standalone
sprint: 69
horizon: m
related: [2860, 1472, 2861, 2864]
umbrella: 2860
---

# Standalone: dynamic-shape object/property operations refused

## Problem

`--target standalone` refuses several dynamic-shape object/property operations
with:

```
Codegen error: '<op>' (dynamic-shape object/property operation) is not yet
supported in --target standalone (#1472 Phase B).
```

### Impact (measured 2026-06-30) — 365 standalone-only failures (all CE)

| op                        | tests | meaning                                                                    |
| ------------------------- | ----- | -------------------------------------------------------------------------- |
| `__get_builtin`           | 314   | reflective read of a built-in/namespace member that missed every fast path |
| `__extern_toLocaleString` | 34    | `.toLocaleString()` on a dynamic receiver                                  |
| `__object_groupBy`        | 10    | `Object.groupBy`                                                           |
| `__object_fromEntries`    | 7     | `Object.fromEntries`                                                       |

## Root cause

`refuseStandaloneObjectImport` (`src/codegen/expressions/late-imports.ts:85`,
list at lines 56-75) hard-refuses these `__*` imports under standalone. They are
the host-mode dynamic fallbacks that have no Wasm-native carrier yet.

`__get_builtin` dominates: it is the generic fallback emitted by
`compileMemberRead` when a property access resolves to a built-in **by name at
runtime** and no fast path / native-proto glue matched (see
`property-access.ts:170-186, 382-386`). A large share of the 314 are
**namespace static reads** — `Math.PI`/`Math.LN2`, `JSON.stringify`,
`Reflect.get`, `Atomics.add` — and reflective `obj[computedName]` against a
built-in. This overlaps with the namespace-static-read follow-on noted in
umbrella #2860 and with #2861.

## Implementation Plan

### Phase 1 — namespace static reads (the bulk of `__get_builtin`)

**File: `src/codegen/property-access.ts`** (`compileMemberRead` / the
`__get_builtin` shortcut site, ~line 382)

- For `Math`/`JSON`/`Reflect`/`Atomics`/`Number`/`Symbol` **namespace** members
  with a statically-known property name:
  - **Data constants** (`Math.PI`, `Math.E`, `Math.LN2`, `Number.MAX_SAFE_INTEGER`,
    `Symbol.iterator`/well-knowns): emit the constant value directly (f64 const,
    or the interned well-known symbol). `Math.PI` etc. already have an exclusion
    note at property-access.ts:382 — extend it to emit the value rather than
    refuse.
  - **Static methods** (`JSON.stringify`, `Reflect.get`, `Math.max`): emit a
    native static-method closure (reuse the `ensureStandaloneBuiltinStaticMethodClosure`
    factory, property-access.ts:686 / the #2175 `"static"` path).

### Phase 2 — `__extern_toLocaleString`

- Route `.toLocaleString()` on a dynamic receiver to the receiver's
  `.toString()` native path (per spec the default `Object.prototype.toLocaleString`
  calls `toString`); for Number/Array/Date use the existing native toString.

### Phase 3 — `Object.groupBy` / `Object.fromEntries`

- Implement as native helpers over the `$Object` runtime + iterator protocol.
  `fromEntries` depends on the iterator carrier — sequence AFTER #2864 if it
  needs generic iteration; the common `Object.fromEntries(array)` case can use
  the `$__vec_base` fast path now.

### Edge cases

- A genuinely dynamic `obj[expr]` where `obj` is user-typed must keep routing to
  the typed struct.get fast path, not `__get_builtin` (unchanged).
- Shadowed namespace identifiers (`const Math = …`) → keep refusing / route to
  the local (guard like property-access.ts:819).

## Test plan

Standalone CE → pass:

- `test/built-ins/Math/**` (PI/LN2/E value reads, max/min static methods)
- `test/built-ins/Atomics/**`, `test/built-ins/JSON/**`, `test/built-ins/Reflect/**`
- `test/built-ins/TypedArray/prototype/toLocaleString/**`
- `test/built-ins/Object/{groupBy,fromEntries}/**`

Full `merge_group` + standalone high-water; zero host-mode regression
(`ctx.standalone`-gated).

## Progress (2026-06-30)

- **Phase 2 (`__extern_toLocaleString`) — DONE** (this slice). Array/TypedArray
  receivers route to the native comma-join (shared with `toString`, gated to
  standalone/wasi in `array-methods.ts`); generic dynamic receivers route to the
  native `__extern_toString` (`expressions/calls.ts`). Host (gc) mode keeps
  `__extern_toLocaleString` for real Intl. Tests:
  `tests/issue-2863-standalone-tolocalestring.test.ts`.
- **Phase 1 staleness note** — the issue's premise that namespace data constants
  (`Math.PI`/`E`/`LN2`, `Number.MAX_SAFE_INTEGER`/`EPSILON`) refuse is now
  **partly stale**: those statically-named reads already compile + fold on
  current main. The remaining Phase 1 work is the static-METHOD **value reads**
  (`JSON.stringify`/`Reflect.get` as a value), reflective `any`-typed
  `namespace[computedKey]` (currently TRAPs, not CE), and any residual
  `__get_builtin` after #2861 landed — re-measure the 314 bucket against current
  main before picking it up.
- **Phase 3 (`Object.groupBy`/`fromEntries`)** — NOT started. `Object.groupBy`
  also needs a lib-types update (currently a TS-level "does not exist on
  ObjectConstructor" error, separate from codegen).

## Progress (2026-07-02) — remeasured vs current main, groupBy landed. status → done

Re-probed every op in the impact table against current `main` (standalone
`compile(..., { target: "standalone" })`). The bulk of the original `__get_builtin`
(314) bucket has already been closed by intervening work; the genuine remainder
splits cleanly into two OTHER issues, and the one self-contained slice left in
`#2863`'s own title (`__object_groupBy`) is implemented here.

- **`__get_builtin` (was 314) — essentially RESOLVED on current main.** Namespace
  static data reads (`Math.PI`/`E`/`LN2`, `Number.MAX_SAFE_INTEGER`) fold to
  constants, and static-method **calls** (`Math.max(…)`, `JSON.stringify(…)`,
  `JSON.parse`, `Reflect.ownKeys(…)`, `Reflect.has`, `Number.isNaN`,
  `String.fromCharCode`, `Array.isArray`/`of`, `Object.keys`, `Symbol.iterator`)
  now compile in standalone without hitting the `__get_builtin` refusal. What
  remains are NOT `#2863`:
  - static-method **value reads** (`const f = JSON.stringify; f(x)`,
    `Math.max`/`Number.isInteger` as a value) → still refuse with the
    `#1907 / #1888 S6-b` "built-in static property value read" message → owned by
    **#2861**.
  - a few reflective _correctness_ bugs (not CE): `Math[computedKey]` and
    `Reflect.ownKeys(o).length` read back `0`; `globalThis.Math.PI` traps. Wrong
    value, not a refusal — left for a targeted follow-up under umbrella **#2860**.
- **`__extern_toLocaleString` (34) — DONE** (Phase 2, prior slice).
- **`__object_groupBy` (10) — DONE (this slice), array / array-like receiver.**
  Native Wasm helper `ensureObjectGroupBy` (`object-runtime.ts`): iterates the
  items via `__extern_length`/`__extern_get_idx` (real Array `$__vec_base` +
  array-like `$Object`), invokes the callback through the proven open-`any`
  closure bridge `__apply_closure` (`keyFn(value, index)`, adapts to arity ≤ 2),
  and groups the ORIGINAL elements into a null-proto `$Object` of `$ObjVec`
  arrays keyed by `ToPropertyKey(callback result)` (uniform via
  `__extern_get`/`__extern_set`). Registered lazily from the call site
  (`expressions/calls.ts`, append-only — no funcidx shift); the callback lowers
  via `compileArrowAsClosure` (NOT `__make_callback`, which would leak an `env`
  import). Zero host imports in the emitted module. The lib-types 2550 "does not
  exist on ObjectConstructor" diagnostic is **non-fatal** in both modes (host
  mode already compiled groupBy fine), so no lib change was needed. Host (gc)
  mode keeps the `__object_groupBy` import unchanged. Tests:
  `tests/issue-2863-standalone-groupby.test.ts`.
  - **Gate:** only array-like items (numeric index signature / array literal)
    take the native path. `Map`/`Set`/generic iterables keep refusing loudly
    (fail-loud, no silent mis-grouping) — their native iteration is the iterator
    carrier follow-up **#2864**.
- **`__object_fromEntries` (7) — array-LITERAL already works** (the existing
  `$ObjVec` normalization at the call site). The runtime/variable and
  generic-iterable cases mis-cast through the nested `__extern_get_idx` boundary
  (`illegal cast` on `[K,V][]`; `0` on `any[]`) — this is the same nested
  array-of-arrays extraction that the iterator carrier **#2864** owns; deferred
  there (as the original plan already sequenced).

**Net for #2863:** the ops named in the title are addressed — `__extern_toLocaleString`
(done), `__object_groupBy` (done, array case), `__get_builtin` (resolved). The
residual sub-cases are genuinely owned by **#2861** (built-in value reads) and
**#2864** (iterator carrier → fromEntries/groupBy over generic iterables), so this
issue is closed and its remainder tracked there under umbrella **#2860**.
