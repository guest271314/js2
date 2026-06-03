---
id: 1716
title: "spec gap (RESIDUAL of #1090/#1525): 'Cannot convert object to primitive value' still thrown in 111 coercion paths"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: toprimitive-coercion
goal: test262-conformance
sprint: Backlog
es_edition: multi
test262_fail: 111
test262_category: built-ins/Object, built-ins/String, built-ins/RegExp, built-ins/JSON, built-ins/Date, built-ins/DataView
related: [1090, 1319, 1525, 1442]
---
# #1716 — ToPrimitive residual: 'Cannot convert object to primitive value' (111 fails)

## Problem (RESIDUAL / possible regression)

THREE closed issues already targeted this exact error string —
#1090 ("ToPrimitive 'Cannot convert object to primitive value' — 161 FAIL",
`done` 2026-04-14), #1319 ("Symbol.toPrimitive / valueOf / toString chain
incomplete — 234 failures", `done` sprint 56), and #1525 ("built-in coercion
paths throw eagerly", `done` 2026-05-28) — yet **111 tests still fail at runtime
with `Cannot convert object to primitive value`**. This is a residual (and
partly a regression-surface) of those closed issues — the fixes did not cover
every coercion site. #1319 was the most recent and broadest; the 111 here are
its residual.

Normalized signature: `runtime_error :: Cannot convert object to primitive value`.

### Distribution (actionable, Temporal/deferred excluded)

| Directory | Count |
|-----------|------:|
| built-ins/Object (getOwnPropertyDescriptor, create, defineProperty/-ies) | 39 |
| built-ins/String/prototype (trim/trimStart/trimEnd this-value coercion) | 26 |
| built-ins/RegExp/prototype (Symbol.split / Symbol.replace species/ctor) | 14 |
| built-ins/JSON (stringify replacer coercion) | 4 |
| built-ins/Date/prototype | 4 |
| built-ins/DataView | 4 |

## Root-cause hypothesis

The remaining sites are **ToPropertyKey / ToString of an object property key**
and **`this`-value ToString coercion** in built-in methods. When an object's
property key (or `this`) only defines `Symbol.toPrimitive` / `valueOf` /
`toString` returning a primitive — or returns an object so the next method must
be tried — our coercion helper throws immediately instead of walking the
OrdinaryToPrimitive method list (§7.1.1 ToPrimitive → §7.1.1.1
OrdinaryToPrimitive: try `valueOf` then `toString`, or the `@@toPrimitive`
exotic method first). #1090/#1525 fixed the *argument* coercion paths but not
the *property-key* (§7.1.19 ToPropertyKey → §13.2.4 PropertyDefinitionEvaluation)
and `this`-value (§22.1.3.x RequireObjectCoercible → ToString) paths.

Spec: [§7.1.1 ToPrimitive](https://tc39.es/ecma262/#sec-toprimitive),
[§7.1.1.1 OrdinaryToPrimitive](https://tc39.es/ecma262/#sec-ordinarytoprimitive),
[§7.1.19 ToPropertyKey](https://tc39.es/ecma262/#sec-topropertykey).

## Example failing tests

- `test/built-ins/String/prototype/trimStart/this-value-object-toprimitive-meth-priority.js`
  (asserts `Symbol.toPrimitive` is consulted before `toString`/`valueOf`)
- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-42.js`
  (object property key coerced via ToString)
- `test/built-ins/Object/create/15.2.3.5-4-235.js`
- `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-non-obj.js`
- `test/built-ins/JSON/stringify/replacer-array-number-object.js`

## Acceptance criteria

- The five example tests above pass.
- The `Cannot convert object to primitive value` runtime-error bucket drops from
  111 to ≤ 30 (allowing for genuinely-deferred Temporal/Symbol edge cases).
- No regression in the previously-fixed #1090 / #1525 example tests.

## Notes

Flagged as a **residual/regression** of `done` issues #1090 and #1525 — higher
priority than a brand-new gap because the cause was supposedly fixed. Coordinate
with #1442 (String.prototype RequireObjectCoercible + ToString), which is in
`review` and overlaps the String subset; this issue owns the **Object
property-key** and **RegExp/JSON/Date** coercion sites #1442 does not.

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).

## Resolution (senior-dev, 2026-05-29)

**Diagnosis: NEVER-COVERED, not a regression.** #1319 fixed `_hostToPrimitive`
(the callbackState-aware OrdinaryToPrimitive walker) and that path works today —
`String(obj)` with a user `toString` already passed. What was never wired:

1. **ToPropertyKey (§7.1.19)** — `_safeGet`/`_safeSet`/`__extern_has` and the
   `Object.*`/`Reflect.*` runtime handlers coerced an object key via
   `_toPrimitiveSync(key, "string")` **without** `callbackState` (or a bare
   `String(prop)`). `_toPrimitiveSync` with no exports cannot dispatch a WasmGC
   closure, so a key whose `valueOf`/`toString`/`@@toPrimitive` is a compiled
   method collapsed to `"[object Object]"` and the lookup silently missed; the
   `Object.*` handlers passed the opaque struct straight to native, which threw.
2. **A class's `[Symbol.toPrimitive]` *method*** had **no runtime dispatch
   export at all.** `valueOf`/`toString` compile to `__call_<name>` 1-arg
   dispatchers (emitted by `emitToPrimitiveMethodExports`) that
   `_hostToPrimitive`'s loop picks up; the exotic `@@toPrimitive` method (which
   takes a hint) was only emitted for `@@iterator`/`next`, so it was unreachable
   from the runtime. The reference to `__call_@@toPrimitive` in `_toPrimitive`
   (runtime.ts) was dead — the export never existed.
3. **Host-constructor object args** — `new RegExp(obj)` / `new Date(obj)` /
   `new String(obj)` / `new Number(obj)` passed the opaque struct to V8's
   constructor, which ran its own ToString/ToPrimitive and threw before reaching
   the compiled methods.

**Fix (reuses #1319/#1525, no duplication):**
- `src/codegen/index.ts` — new `emitToPrimitiveMethodExport`: emits a 2-arg
  `__call_@@toPrimitive(self, hint) -> externref` dispatch wrapper (called in
  both `generateModule` and `generateMultiModule`). Skips entries whose hint
  param isn't externref (nativeStrings standalone path is JS-host-free), keeping
  Wasm validation green in every mode.
- `src/runtime.ts`:
  - `_toPrimitiveSync` gained an optional `callbackState`; for WasmGC structs it
    now defers to `_hostToPrimitive` (the #1319 walker) instead of the
    "[object Object]" sentinel.
  - `_hostToPrimitive` now probes the new `__call_@@toPrimitive(self, hint)`
    export for the method-shorthand `[Symbol.toPrimitive]` shape (the sidecar
    slot is empty for class methods).
  - new `_toPropertyKey(key, callbackState)` helper (§7.1.19) applied at
    `__defineProperty_{desc,value,accessor}`, `__getOwnPropertyDescriptor`,
    `__object_hasOwn`, and all six `Reflect.*` key handlers.
  - `_safeGet`/`_safeSet`/`__extern_get`/`__extern_set`/`__extern_has` thread
    `callbackState` into the key coercion.
  - the `extern_class` constructor coerces WasmGC struct args through
    `_hostToPrimitive` for RegExp/Date/String/Number (Boolean excluded — it runs
    ToBoolean, not ToPrimitive).

A §7.1.1.1 step-6 violation (a coercion method returning an object) still throws
TypeError on every path — spec-correct.

**No-regression evidence:** #1319 (3), #1525 (10), #1525b (5), #1442 (10),
#1629a/b (8), #1630 (5), object-methods, object-keys-values-entries all stay
green alongside the new #1716 suite (10). The class-methods/iterators test files
fail identically on clean origin/main (their `{ env: {} }` harness omits
`string_constants`) — pre-existing, not touched by this change.

**Test:** `tests/issue-1716.test.ts` (10 tests) — property-key valueOf/@@toPrimitive,
Object.getOwnPropertyDescriptor/defineProperty with object keys, String/RegExp/Date
object args, the step-6 TypeError guard, and the #1319 "defined method still wins"
guard.

PR: see implementation PR. Expected impact: ~+111 (the unified cluster).
