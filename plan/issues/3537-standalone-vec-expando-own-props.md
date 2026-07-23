---
id: 3537
title: "standalone: expando own-properties on array ($Vec) receivers are silently dropped — writes no-op, reads answer undefined"
status: in-progress
assignee: ttraenkler/fable-exposed
created: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: property-write, dynamic-property, arrays
es_edition: es5
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [3468, 3251, 2860, 3180]
origin: "#3468 cliff clustering (2026-07-23, fable-exposed): cluster 6 — 26/458 sampled regressions (~208 projected) trace to array expando drops, NOT to RegExp .index (exec().index works; the harness arrays' `__expected.index = 0` expando is what drops)"
# (#3102) The substrate is the NEW leaf module src/codegen/vec-props.ts; these
# god-file touches are the unavoidable arm/wiring minimum (mirrors the #3468
# C-core grant): 3 arm call-site swaps in object-runtime.ts, the reserve/fill
# ctx flags in context/types.ts, and the finalize calls in index.ts.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
---

# #3537 — standalone: array ($Vec) expando own-properties dropped

## Problem

Under `--target standalone`, assigning a **named expando property to an
array** is silently dropped, and reading it back answers `undefined`:

```js
var __expected = ["abc", "a"];
__expected.index = 0;          // write reaches __extern_set, dies in the
__expected.input = "abc";      // non-$Object arm (silent no-op)
__expected.index;              // undefined
```

All four probed shapes fail on current main (verified 2026-07-23, WAT shows the
write DOES reach the dynamic runtime — this is a runtime dead-arm, not a
front-end drop):

| shape | result |
| --- | --- |
| top-level `a.index = 0` on array var (`.js`, harness shape) | dropped |
| in-function `(a as any).x = 5; (a as any).x` | undefined |
| aliased `var g: any = a; g.x = 7; g.x` | undefined |
| identity `g.x = 9; (a as any).x` | undefined |

## Why it matters (measured, #3468 cliff clustering)

- **Cluster 6 of the #3468 exposure histogram: 26/458 sampled regressions
  (~208 projected of the 3,664 cliff)** are test262 files whose *harness
  arrays* carry expandos (`__expected.index/.input` in the classic RegExp
  suites, etc.). `RegExp.exec().index` itself WORKS — the mirage "regexp
  .index" cluster label was killed by probing; the actual drop is the
  **expected-array expando**.
- Part of the own-property family (~2,100–2,500 tests total: #3468 closures ×
  this array arm × builtin namespaces × class prototypes + the ~1,591
  F3-unmasked `verifyProperty` rows). Routed to this lane by the tech lead
  (2026-07-23); closure receivers stay #3468-owned, descriptor/attribute
  fidelity stays #3251-owned.

## Root cause

`a.p = v` / `a.p` on a `$Vec` receiver route to `__extern_set` / `__extern_get`
(`src/codegen/object-runtime.ts`), which gate on `ref.test $Object`. A real
array is a `__vec_<kind>` struct subtyping `$__vec_base` — NOT a `$Object` — so
the write falls into the (#3468-filled-for-closures) non-object arm, which
today only handles capturing-closure receivers and otherwise no-ops/answers
undefined. Same family as the #3468 closure gap, receiver kind = array.

## Fix (this PR) — mirror of the #3468 C-core side table, ARRAY arm

New leaf module `src/codegen/vec-props.ts` (closure-props.ts is NOT edited —
it is #3468-owned; composition happens in the arm builders):

- `$VecPropEntry { next; key: eqref; bag: externref }` + module global
  `$__vec_prop_head`, standalone/wasi only (host lane byte-identical — the
  `env::__extern_*` imports own that path).
- Reserved-then-filled helpers (same funcIdx-ordering discipline as
  `reserveClosurePropHelpers`/`fillClosurePropHelpers`):
  `__is_vec_prop_carrier` (single `ref.test $__vec_base`), `__vec_bag_lookup`,
  `__vec_bag_ensure`, `__vec_prop_get`, `__vec_prop_set`.
- The three `__extern_*` non-object arms now route through composed builders
  (`buildVecOrClosureProp*` in vec-props.ts) that test the vec carrier FIRST
  and fall through to the UNCHANGED #3468 closure arm otherwise.
- **`"length"` is excluded at SET time** (native-string compare, the
  `fillBuiltinFnMeta` classify pattern): the bag can never shadow the real vec
  length, regardless of which read path answers `.length`.

Out of scope (documented boundaries):
- reflection (`in`/`delete`/`Object.keys`/`hasOwnProperty`/gOPD) over the bag —
  family follow-on, same C-complete boundary as #3468;
- numeric index keys — vec ELEMENTS, and per-index descriptor fidelity is
  #3251's overlay epic;
- builtin-singleton expandos (`Math[0]`, #3180 bucket 3) — different receiver
  rep, follow-on can reuse this substrate pattern.

## Test plan

`tests/issue-3537.test.ts`, `--target standalone`:
- write/read round-trip on array expando (top-level and in-function);
- alias identity (`g.x = 9` visible via `a.x`);
- distinct arrays don't cross-talk;
- `.length` NOT shadowable (`(a as any).length = 99` → `a.length` unchanged);
- elements unaffected by expando writes;
- host lane (`gc`) byte-identical on a no-expando program.

## Measured validation (record before merge)

- main+fix: the 4 probe shapes flip to correct; no standalone floor loss.
- #3468-harness+fix: the cluster-6 sample files flip fail→pass (report the
  count — this banks against the cliff).
