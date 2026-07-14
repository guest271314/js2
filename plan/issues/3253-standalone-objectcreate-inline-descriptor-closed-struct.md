---
id: 3253
title: "standalone Object.create inline descriptor literal compiles to closed struct → value + ToBoolean flags dropped"
status: done
created: 2026-07-13
completed: 2026-07-13
assignee: ttraenkler/opus-crashes
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: Object.create
goal: standalone-mode
umbrella: 1781
related: [3246, 2076, 2580, 1906, 2515]
es_edition: ES5
loc-budget-allow:
  - src/codegen/expressions/calls.ts
---
# #3253 — standalone Object.create inline descriptor literal → closed struct

## Problem

Under `--target standalone`,
`Object.create(proto, { p: { value: 9, configurable: new Boolean(true) } })`
silently dropped the property `value` AND the ToBoolean-coerced
`writable`/`enumerable`/`configurable` flags whenever a flag was **non-static**
(anything `staticToBoolean` can't fold at compile time — e.g. a `new Boolean(…)`
wrapper, an identifier, a call).

Observed (pre-fix, standalone):
- `Object.create({}, {p:{value:9,configurable:new Boolean(true)}})` → `o.p` read
  `0` (value lost), `gOPD(o,'p').configurable` was `false` (should be `true` —
  `new Boolean(true)` is a truthy object), `delete o.p` failed.
- A **value-only** descriptor (`{p:{value:5}}`) and the equivalent
  `Object.defineProperty` call both worked — isolating the bug to the
  Object.create runtime-descriptor path.

## Root cause

When every flag is `staticToBoolean`-resolvable, `Object.create` uses the
static-expansion fast path (`__defineProperty_value` with precomputed flags). A
**non-static** flag disqualifies that path, so it falls to the runtime applier
`__obj_define_from_desc(obj, key, descObj)` (object-ops.ts), which runs
ToPropertyDescriptor over `descObj` **guarded by `ref.test $Object`**.

The inline descriptor literal `{ value: 9, configurable: … }` has a **concrete
contextual type** (`PropertyDescriptor`, not `any`), so `compileObjectLiteral`
built it as a **closed struct**. `ref.test $Object` fails on a closed struct →
the applier reads nothing → `value` unset, all flags default `false`. This is
the same closed-struct-vs-`$Object` diversion fixed for `Object.assign`
arguments and `Object.create` protos in #2076 / #2580.

## Fix

`src/codegen/expressions/calls.ts` (~L8463, Object.create runtime-descriptor
branch): when `ctx.standalone` and the descriptor is an object literal, build it
via `compileObjectLiteralAsExternref` (native `$Object`) instead of the generic
`compileExpression`. Falls through to the generic path for non-literal / skipped
shapes (the helper returns `null` only before any emit and skips computed/symbol
keys, so the fall-through is side-effect-free). Standalone-gated; host/gc/wasi
lanes untouched (byte-neutral).

## Result

- **+20 standalone host-free Object/create tests** (18 → 38 pass of the 105-file
  "Property description must be an object" descriptor cluster on the #3246 base).
- No `Object.defineProperties` regression (this path is Object.create-specific).
- Pre-existing `issue-2515` (1) / `issue-2992-accessor-merge` (4) failures
  confirmed present on pristine main too — NOT caused by this change.

## Residual (out of scope — separate roots)

The remaining ~67 Object/create failures use descriptors that are **not inline
object literals**:
- descriptor is a **function / RegExp / array** object with expando descriptor
  fields (`funObj.set = …; Object.create({}, {p: funObj})`) → blocked on #3252
  (array/function expando-property writes don't stick) and opus-defineprop2's
  #3251 array-descriptor-overlay epic.
- descriptor is an **identifier** holding a plain object with an **accessor**
  field (`get configurable(){…}`) → needs the non-literal-descriptor path to
  read accessor fields.

Not bundled here per scope-first.
