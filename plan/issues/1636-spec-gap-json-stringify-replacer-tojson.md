---
id: 1636
title: "spec gap: JSON.stringify replacer/toJSON/property-list (49 of 66 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: json
goal: spec-completeness
sprint: 50
renumbered_from: 1341
parent: 1328
related: 1324
---
# #1341 — JSON.stringify: replacer function, toJSON method, property-list filter

## Problem

`built-ins/JSON/stringify`: **17 / 66 pass (25.8%)** — 42 assertion_fail, 2 type_error,
2 runtime_error, 1 other, 1 null_deref.
`built-ins/JSON/parse`: 55 / 77 (71.4%) — 19 assertion_fail.

Spec §25.5.2 (JSON.stringify) requires:
1. **`replacer`** can be a function (called for every key, with `(key, value)`) or an Array
   (used as a property allow-list for objects).
2. **`toJSON`** method on a value: if present, called via `Get(value, "toJSON")` and the result
   replaces the value (Date, BigInt, Temporal use this).
3. **`SerializeJSONProperty`** algorithm: nested objects, arrays, escaping, NaN/Infinity → null.
4. **Cycle detection** must throw TypeError.
5. **Indent** can be a Number or String, capped at 10 spaces.

Current `__json_stringify` host-imports JS `JSON.stringify` directly, which should be spec-compliant.
The 42 assertion_fail errors strongly suggest:
- We're calling `JSON.stringify(value, replacer, space)` but the replacer is a Wasm closure that
  the host JS engine cannot invoke (no JS-to-Wasm bridge for the replacer callback).
- Or: the Wasm callbacks are wrapped in a way that loses the `this` (the holder object) per spec
  §25.5.2.2.

Pure-Wasm JSON is tracked by #1324; this issue is the host-mode fidelity problem.

## Acceptance criteria

1. `built-ins/JSON/stringify/replacer-function-arguments.js` passes.
2. `built-ins/JSON/stringify/value-tojson-{primitive,object}.js` passes.
3. `built-ins/JSON/stringify/replacer-array-{normal,non-normal}.js` passes.
4. Pass-rate for `built-ins/JSON/stringify` rises from 26% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__json_stringify`, `__json_parse` callback bridge
- `src/codegen/registry/json.ts` (or equivalent registration)

## Implementation Plan

### Root cause

Replacer is a function, but when crossing into host JSON.stringify the host expects to call
the replacer as a JavaScript function with `this` set to the holder. Our Wasm function refs
are not directly JS-callable (issue #1308) — they need an externref-callable trampoline.

### Approach

1. Wrap Wasm-replacer functions in a JS closure at boundary: `function (k, v) { return wasmFn(this, k, v); }`.
2. For Array replacers (property-list mode): pass the array directly to host; spec says only
   strings and numbers are honored.
3. For the `toJSON` lookup: JSON.stringify host code does `Get(value, "toJSON")` — works automatically
   for externref objects with toJSON; for typed structs we may need to inline the lookup before
   handing the value to the host (since host can't see Wasm struct fields).

### Edge cases

- Replacer returns undefined for an array element → element becomes null per spec.
- toJSON is not a Function → ignored (no error).
- Property-list replacer with duplicate names → use first occurrence per spec.
- Object with cyclic reference → TypeError.

### Test262 sample

- `test262/test/built-ins/JSON/stringify/replacer-function-arguments.js`
- `test262/test/built-ins/JSON/stringify/value-tojson-object.js`
- `test262/test/built-ins/JSON/stringify/replacer-array-normal.js`

## Investigation 2026-05-27 (dev-1611) — ESCALATE, needs architect respec

Measured against `origin/main` 6d5a806d via `runTest262File`:
`built-ins/JSON/stringify` = **18 / 66 pass, 48 fail** (no `skip`).

The 48 failures bucket into distinct root causes — this is NOT a single
localized `runtime.ts` patch:

| count | bucket | scope |
|------|--------|-------|
| 6 | Proxy targets/replacers (revoked + live) | OUT OF SCOPE — needs Proxy (deferred) |
| 2 | cross-realm `$262.createRealm` | OUT OF SCOPE — no realm harness |
| 6 | cycle detection → must throw `TypeError` | host `JSON.stringify` never sees the cycle (we eager-flatten) or stack-overflows |
| 5 | `toJSON` honoured | dynamic `.toJSON =` on arrays/wrappers + closure invocation |
| 6 | wrapper-object → primitive (`new Number`/`new String`/`new Boolean`) + space/order | `_toPrimitive` throws "Cannot convert object to primitive" |
| 5 | BigInt: `JSON.stringify(0n)` must throw TypeError; `value-bigint-tojson` | overlaps BigInt semantics |
| 9 | replacer array (property-list) + replacer function | Wasm-closure ↔ host-value marshaling (#1308) |
| ~9 | misc: string escaping, function/symbol → undefined, abrupt completions | mixed |

### Why the obvious fix (toJSON + cycle in the struct converter) is a no-op

I prototyped a JSON-specific `_jsonToPlain` that (a) invokes a callable
`toJSON` field via `__sget_toJSON` + `__call_fn_1`, and (b) threads a
visited-`Set` to throw `TypeError` on cyclic WasmGC structs. **Pass count
unchanged at 18/66, zero regressions** — reverted (a no-op should not ship).
Reason: these test262 inputs are object literals / `new String()` /
`new Number()` wrapper objects with *dynamically-added* `.toJSON =`, which in
our pipeline are **host JS objects (externref)**, not WasmGC structs — so
`_isWasmStruct(val)` is false and the struct-guarded helper never fires. The
values reach host `JSON.stringify` directly, where the failures are really:
1. **replacer/toJSON are Wasm closures** that cannot consume the host JS
   values `JSON.stringify` hands them (`value + '|replacer'` runs Wasm string
   ops on an externref). This is the #1308 "Wasm fn refs are not JS-callable"
   gap — the `__call_fn_2` bridge passes values through untranslated.
2. **wrapper objects** (`new Number(2)`) hit `_toPrimitive` → throws instead
   of serialising to their primitive.
3. **BigInt** must throw `TypeError` from stringify, not silently stringify.

### Recommendation

Needs an **architect spec** for the JS↔Wasm closure-value marshaling boundary
(shared with #1308) before a dev can land this. The correct shape is a
`SerializeJSONProperty` reimplementation in `runtime.ts` that drives the walk
itself (so it can marshal values into/out of the replacer/toJSON closures,
look up dynamically-added `toJSON`, ToPrimitive wrapper objects, and
cycle-check) rather than delegating the whole tree to host `JSON.stringify`.
Proxy + cross-realm (8 tests) stay out of scope. Realistic in-scope ceiling
after the marshaling boundary exists: ~34 of 48 (Proxy/cross-realm excluded).
