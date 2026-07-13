---
id: 3133
title: "Standalone .constructor on plain-object/array receivers reads undefined — route to the Object/Array namespace-object identity singletons"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-12th
sprint: 71
created: 2026-07-10
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: builtins
goal: standalone-mode
related: [2963, 3006, 2984, 2999]
origin: "task #55 identity-substrate tail re-measured on current main (2026-07-10) — the live remainder after #3006/#2965/#2988 landed"
loc-budget-allow:
  - src/codegen/property-access.ts
---

# #3133 — plain-object/array `.constructor` reads undefined standalone

## Problem

Measured on current `main` (2026-07-10, `--target standalone --nativeStrings`):

| Probe                                     | main    |
| ----------------------------------------- | ------- |
| `({}).constructor === Object`             | `false` |
| `[1].constructor === Array`               | `false` |
| `Object.prototype.constructor === Object` | `false` |
| `Array.prototype.constructor === Array`   | `false` |

The reads return `undefined` — they fall through to the dynamic `$Object`
own-prop read, which has no `constructor` slot. #3006 gave the
Set/Map/Weak\* family genuine reified constructor identity but deliberately
EXCLUDED `Object`/`Array` ("already carry a genuine bare-value identity —
namespace objects"). True for the **bare value** — but the `.constructor`
READ path for their instances/prototypes was never routed anywhere.

Much of the rest of the briefed identity-substrate tail is ALREADY fixed on
main (stale-briefing verified): `%ArrayIteratorPrototype%` identity,
`Object_set_constructor`, Set-family ctor identity (#3006), basic
`instanceof`, `globalThis` defineProperty (#2988/#2996).

## Fix

New arm in `compilePropertyAccess` (`src/codegen/property-access.ts`),
directly after the #3006 arm: standalone `.constructor` on a receiver whose
static type classifies as a plain object (`Object` interface / anonymous
object-literal type) or array (checker-confirmed array/tuple,
`Array`/`ReadonlyArray`) routes to `emitBuiltinNamespaceObject(ctx, fctx,
"Object" | "Array")` — the SAME per-name `__builtin_<Name>` mutable global
the bare identifier resolves to (identifiers.ts ~769). So the identity is
GENUINELY true (same WasmGC object through `ref.eq`, survives the
externref-widening sameValue harness boundary) and the swap-wrong-builtin
cross-check (`({}).constructor === Array`) is GENUINELY false.

Conservative gates (decline → current behavior):

- `any`/`unknown` (the #2026 tag-dispatch arm owns those), union/intersection;
- callables/constructables; user-declared `{ constructor: v }` members
  (non-lib declaration check);
- `"__object"` literal types only, NOT `"__type"` annotations
  (`const o: {} = new A()` says nothing about the runtime constructor);
- module-wide syntactic guard: any assignment to / delete of a
  `.constructor` property anywhere in the module declines the fold
  (`moduleTouchesConstructorProp`, cached per source file);
- standalone-only — gc/host keeps the genuine `Object_get_constructor` read.

## Test Results

- `tests/issue-3133-instance-constructor-identity.test.ts` — 14/14 pass
  (identity, swap guards, harness boundary, class instances untouched,
  user-own-prop, type-literal decline, assign-guard decline, #3006 family
  untouched, zero `env::` imports).
- Adjacent suites green: issue-2963 (identity singletons), issue-3006
  (ctor identity), issue-2916 (instanceof), 8 scoped equivalence files
  (object-create/keys/mutability, prototype-chain, wrapper-constructors,
  array-prototype-methods, typeof-member, empty-object-widening) — 53/53.
- Real test262 flips measured vs main control (standalone lane):
  - `built-ins/Object/prototype/constructor/S15.2.4.1_A1_T1.js` fail → pass
  - `built-ins/Object/S15.2.2.1_A1_T1.js` fail → pass
  - `built-ins/Array/prototype/constructor.js` fail → pass
  - host lane identical to main on all controls (change is standalone-gated).
  - `S15.2.4.1_A1_T2.js` (`new Object.prototype.constructor`) still fails on
    BOTH lanes pre-existing — reified namespace values are not constructible
    (follow-up candidate, same family as #2963 Phase-2 value-call dispatch).

## Remaining (out of this PR's scope)

- `class X extends Object` still leaks `env::__new_Object` (5 tests) —
  #2963's table routes this to the #2984 receiver-family; coordinate with
  the #2984 owner before taking it.
- `typeof globalThis` reads `"undefined"` standalone (the object exists and
  is identity-stable; the typeof lowering misses it) — same class as the
  known typeof-prop-access fold quirk noted in #2963's tests.
- `typeof o.constructor` → not `"object"` (typeof-of-prop-access fold path,
  pre-existing, separate from the identity read).
