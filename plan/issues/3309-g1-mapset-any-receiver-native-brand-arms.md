---
id: 3309
title: "G1 — Map/Set methods on an `any` receiver leak env.WeakMap_*/Set_* host imports standalone: native $Map brand arm in the closed-method dispatcher"
status: done
completed: 2026-07-16
assignee: ttraenkler/fable-interp
created: 2026-07-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: collections
goal: runtime-eval
sprint: 72
parent: 2927
related: [2928, 1584, 2151, 1103, 2162, 3171, 3098]
# (#3102/#3131) intended growth: the standalone refusal must live in the
# any-receiver extern-class scan (calls-closures.ts, mirrors the existing
# slice/replace/forEach/fill refusals) and the $Map brand arm in the
# closed-method dispatcher (same home as the #2583/#2927/#3098/#3173 arms).
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/closed-method-dispatch.ts
---

# #3309 — G1: native Map/Set dispatch for a genuinely-`any` receiver (standalone)

Slice **G1** of the #2928 `CallBuiltin` prerequisites
(`docs/architecture/runtime-eval-interpreter.md` §16; #2927 Part-2 audit gap 1).
A **hard** prerequisite of E5. Shared work with standalone AOT any-receiver
dispatch — not interpreter-only.

## Problem (verified on upstream/main `bdb8491ee1`, 2026-07-16)

```ts
const m: any = new Map();
m.set("k", 42);
m.get("k");
m.has("k");
const s: any = new Set();
s.add(7);
s.has(7);
```

Under `target: "standalone"` this emits **`env.WeakMap_set` / `env.WeakMap_get`
/ `env.WeakMap_has` / `env.Set_add`** function imports — unsatisfiable host
imports (module fails the host-free floor / traps), even though the WasmGC-native
Map/Set runtime (`src/codegen/map-runtime.ts`, `set-runtime.ts`) fully serves the
_typed_-receiver case.

## Root cause — CORRECTED mechanism (the #2927 narrative was stale)

The #2927 audit attributed the leak to the `className === "Map"` interception
gate in `src/codegen/expressions/extern.ts:60-93`. That interception is indeed
skipped for `any` (no type symbol), but it is **not** where the imports come
from — under standalone the Map/WeakMap/WeakSet externClasses of
`registerBuiltinExternClasses` are all `!ctx.nativeStrings`-gated and never
registered. The real path:

1. `checker.getTypeAtLocation` on an explicit-`any` binding returns unnarrowed
   `any` (no symbol) → every symbol-keyed native interception is skipped, and
   the call lands in the any/externref generic ladder
   (`src/codegen/expressions/call-receiver-method.ts:2514`).
2. **`tryExternClassMethodOnAny`** (`src/codegen/expressions/calls-closures.ts`
   ~1479–1514, `addImport` at ~1510) does a **first-match scan over
   `ctx.externClasses`** for any class with an all-externref method of that
   name and emits `env.<importPrefix>_<method>`.
3. Its candidate pool under standalone **still contains WeakMap/Set/WeakSet**:
   the lib `.d.ts` declare-var scan (`collectExternFromDeclareVar`,
   `src/codegen/extern-declarations.ts:782`) nativeStrings-gates **only
   `"Map"`** (line ~790) — WeakMap/Set/WeakSet from `lib.es2015.collection.d.ts`
   register as externClasses. Insertion order makes **WeakMap** win first-match
   for `set`/`get`/`has` and **Set** for `add`.
4. Because `tryExternClassMethodOnAny` returns non-null at
   `call-receiver-method.ts:2601`, the #2151 closed-method dispatcher lane at
   `:2629` — where the native brand arms live — is **never reached**.

## Fix (this PR — mirrors the merged #2927 push/pop arm, PR #2592)

1. **Refuse the collection method names in `tryExternClassMethodOnAny` under
   standalone/wasi** (`get`/`set`/`has`/`add`/`delete`/`clear`), the same
   pattern as the existing `indexOf`/`forEach`/… refusals that route those
   names to the dispatcher. JS-host mode is untouched (the host bridge works
   there).
2. **`$Map` brand arm in the closed-method dispatcher**
   (`src/codegen/closed-method-dispatch.ts`): all four collections share the
   `$Map` struct with an immutable `kind` tag (`COLLECTION_KIND`, #3171 —
   MAP 0 / SET 1 / WEAKMAP 2 / WEAKSET 3), so ONE `ref.test ctx.mapTypeIdx`
   arm serves them, with a kind guard per method:
   - `get_1` (MAP|WEAKMAP) → `__map_get`, result anyref → `extern.convert_any`
   - `set_2` (MAP|WEAKMAP) → `__map_set` (args `any.convert_extern`d), returns
     the map → chainable receiver via `extern.convert_any`
   - `has_1` / `delete_1` (all kinds) → `__map_has`/`__map_delete` (i32) →
     `__box_boolean`
   - `add_1` (SET|WEAKSET) → `__set_add`, chainable
   - `clear_0` (MAP|SET; weak collections have no clear) → `__map_clear` →
     `ref.null.extern`
     Kind-guard misses return `ref.null.extern` (`undefined`), matching the
     pre-fix open-`$Object` fall-through (a brand-check TypeError refinement is
     #2604-family follow-up territory, host-free either way).
3. **Reserve-then-fill discipline (#1719)**: `ensureMapHelpers` +
   `ensureSetHelpers` + `addUnionImportsViaRegistry` (`__box_boolean`) run at
   RESERVE time in `reserveClosedMethodDispatch`, so
   `fillClosedMethodDispatch` only READS `ctx.mapHelpers`/`funcMap` (the
   #2043/#1677 late-import shift hazard). The module-level import
   `closed-method-dispatch.ts → map-runtime.ts` is cycle-safe (the
   `hof-native.ts ↔ closed-method-dispatch.ts` precedent).
4. The arm sits UNDER the closed-struct/field arms (a user `{ get(){…} }`
   still wins) and above the open-`$Object` bottom arm; a `$Map` can never
   match a closed-struct or vec test, so relative order among brand arms is
   behavior-neutral.

Key-representation consistency is free: the dispatcher call site boxes number
args via `__box_number` + the arm converts `any.convert_extern` — the same rep
`coerceArgToAnyref` produces on the typed path, so hashing/SameValueZero agree.

## Acceptance criteria

- [x] The probe above compiles standalone with **0 function imports** and runs
      correctly (`m.get("k") === 42`, `has` true, `s.has(7)` true).
- [x] Chainability: `m.set(a,1).set(b,2)`, `s.add(1).add(2)` on `any`.
- [x] `delete`/`clear` on `any` receivers work host-free.
- [x] Typed-receiver Map/Set paths and JS-host mode byte-stable (scoped suites
      green: #2151/#2583/#2604 families, map/set tests).

## Test Results (2026-07-16, branch `issue-2927-g1-mapset-brand`)

- `tsc --noEmit` clean.
- `tests/issue-3309-standalone-any-mapset.test.ts` — **12/12** (host + host-free
  standalone; 0-fn-import asserted per standalone case).
- Neighbor suites green: #2927 push/pop (7), #2151 + nary + dynamic-spread,
  #1103a standalone-map, #2162 standalone-set/weak/map-foreach/set-algebra/
  iterators/set-foreach/entries-foreach, #2583 (17), #2605/#2606, #3098, #3117.
- 3 failures reproduce IDENTICALLY on clean main (pre-existing, not this PR):
  `issue-2151.test.ts` "custom iterable driven via any-method .next()"
  (standalone+wasi, Wasm exception) and `issue-3098.test.ts`
  "find/findIndex/findLast/findLastIndex".
- Substrate caveats verified pre-existing on clean main (not this fix): a miss
  result compares `== null` but not `=== undefined` (same for TYPED `Map.get`
  miss and the open-`$Object` bottom arm — #2106-family); typed inline
  `m.get(k) === 7` fails standalone while the same compare through a
  `const g: any` binding passes.

## Notes

Remaining sibling gaps tracked separately: G2 #3310 (args on the generic
open-`$Object` path), G3 done (#3098/#3235), G4 #3311 (`string[]` push
carrier). Umbrella: #2927 → #1584.
