---
id: 3246
title: "standalone ToPropertyDescriptor rejects non-$Object descriptors (function/array/wrapper) as \"unsupported shape\""
status: done
sprint: 71
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
assignee: ttraenkler/opus-leak3
completed: 2026-07-13
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

## Problem

Under `--target standalone`, the native `Object.defineProperty` /
`Object.defineProperties` / `Object.create(O, Properties)` machinery
(`src/codegen/object-runtime.ts`) required every **property descriptor** to be
a native `$Object` struct via a `ref.test $Object` gate. Per ECMA-262
§6.2.5.6 ToPropertyDescriptor, the descriptor need only be an **Object** — a
function, array, wrapper object, or any object-with-getters is a perfectly
valid descriptor. The over-strict gate threw a spurious
`TypeError: Property description must be an object` /
`Object.defineProperties unsupported descriptor shape in standalone mode`.

This was the sharpest concentrated sub-signature in the post-flip host-free-FAIL
landscape (measured 2026-07-13 against the fresh `test262-standalone-current.jsonl`,
promoted 17:48 UTC, post-#3020-flip):
- `type_error: Property description must be an object` — 191 host-free fails
  (Object/create 105, defineProperty 72, prototype 12, Reflect 1)
- `Object.defineProperties unsupported descriptor shape in standalone mode` — 78
  (defineProperties 54, create 24)

Both classes are **host-free FAILs** — they compile with zero `env::` imports
and fail only at runtime — so a semantics fix flips them directly to
`host_free_pass` (the standalone-floor metric, #2879 §2).

Representative failing tests:
- `built-ins/Object/create/15.2.3.5-4-279.js` — per-property descriptor is a
  Function object (`Object.create({}, { prop: funObj })`)
- `built-ins/Object/create/15.2.3.5-4-140.js` — attribute field is a wrapper
  (`{ configurable: new Boolean(true) }`)

## Root cause

Two `ref.test $Object` gates in `object-runtime.ts` (the `__defineProperties`
gather path per-property gate, and the single-triple `__obj_define_from_desc`
desc gate) threw whenever the descriptor was not our specific `$Object` struct
representation. But the descriptor field reads underneath (`hasField` →
`__hasOwnProperty`, `getField` → `__extern_get`) dispatch **dynamically on any
object externref** — they already work on functions, arrays and wrappers. So
the gate, not the readers, was the sole blocker.

## Fix (this slice — descriptor is ANY object)

Widen both gates from `ref.test $Object` to the object-or-function predicate
`__typeof_object(x) | __typeof_function(x)` (accepts plain objects, arrays,
functions; rejects primitives). `__typeof_object` already excludes boxed
number/boolean/bigint, native strings and the tag-1 `undefined` singleton, and
`__typeof_function` (patched by #1896) recognises closures — so the union is
exactly "Type(x) is Object OR x is callable".

**Null hole (caught by a regression-sample check):** `__typeof_object(null)`
returns 1 (typeof null === "object" under the #2106 S1 singleton regime), but
`Type(null)` is NOT Object, so a `null` descriptor value must still throw
(§6.2.5.6 step 2 — `Object.defineProperties({}, { a: null })`). The gather gate
therefore rejects `ref.is_null` explicitly **before** the typeof union. (The
single-triple path already no-ops a null desc before its gate, unchanged.)

**Standalone-gated / host byte-identical:** host & wasi modes route
`Object.defineProperty*` through the `__defineProperty_desc` import
(object-ops.ts:366-393), never this native gather/single-triple code — so the
change fires only under `--target standalone`; host wasm output is byte-identical.

Builds on the existing descriptor machinery: #1629 (`__defineProperty_value`),
#1888 (`__defineProperty_accessor`), #1906 (defineProperties gather),
#2042-S4 / #2992-S3 (ValidateAndApplyPropertyDescriptor preflights).

### Measured impact (local standalone runner, 2026-07-13)
- **+39 host_free_pass** across the 269-file propdesc+unsupported bucket
  (`built-ins/Object/{defineProperty,defineProperties,create}`).
- **0 regressions** — 200/200 random baseline host-free-pass files in the three
  dirs still pass; the null-descriptor negative test passes.

## Deferred follow-up slices (NOT in this PR)
- **Properties is a non-`$Object` object** (e.g. `Object.create({}, Math)`):
  the `objOrderedIdx` enumeration still requires a `$Object` Properties map —
  needs generic own-enumerable-key enumeration. ~63 remaining "unsupported".
- **`Object.create(O, undefined)` → no-op** (Properties undefined per §Object.create
  step 2): handle at the call site (`expressions/calls.ts`), since the shared
  `__defineProperties` helper must still throw for `Object.defineProperties(O, undefined)`.
- **Wrapper-object attribute values / whole-descriptor wrappers** (`new Boolean(true)`):
  a ToBoolean / value-rep issue distinct from the gate (some of the 191 have a
  compounding downstream bug — accessor install, wrapper ToBoolean, delete).
- **Array-exotic non-configurable redefinition validation**
  (`15.2.3.6-4-244` "Expected TypeError not thrown") — separate cluster.
