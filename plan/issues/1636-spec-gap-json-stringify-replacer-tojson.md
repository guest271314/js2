---
id: 1636
title: "spec gap: JSON.stringify replacer/toJSON/property-list (49 of 66 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
escalation: needs-architect-spec
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

> **Status correction (2026-05-27).** A prior agent recorded this issue as
> ~87.9% / effectively done. That was wrong. Re-measured on current `main`
> via the real test262 runner: **`built-ins/JSON/stringify` = 18 / 66 (27.3%)**.
> The issue is genuinely OPEN, the root cause is structural (not a localized
> `src/runtime.ts` patch), and it is escalated for an architect spec.
> See **§Confirmed root cause** and **§Escalation** below.

## Problem

`built-ins/JSON/stringify`: **18 / 66 pass (27.3%)** (re-measured 2026-05-27 on
current main) — dominated by assertion_fail, with type_error / runtime_error /
null_deref tails.
`built-ins/JSON/parse`: ~71% (separate, not addressed here).

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

## Confirmed root cause (2026-05-27)

The previous "Implementation Plan" assumed a localized fix at the
`__json_stringify` boundary (wrap the Wasm replacer in a JS closure). That
is **necessary but not sufficient**, because of a deeper, structural problem
in how Wasm values reach the host serializer.

**`_wasmToPlain` flattens the value graph *before* host `JSON.stringify` sees
it** (`src/runtime.ts:1564`, invoked from the stringify path at lines ~3075,
~3098, ~3534). It walks named structs (`_structToPlainObject`) and vec
wrappers recursively and returns a fresh plain JS object/array tree. By the
time the host `JSON.stringify(plain, replacer, space)` runs, the original
WasmGC values are gone. This loses, *irrecoverably*, everything
`SerializeJSONProperty` (§25.5.2.2 / §25.5.2.3) needs to observe on the
**live** value:

1. **`toJSON`** — §25.5.2.2 step 2 does `Get(value, "toJSON")` and, if
   callable, invokes it with the *original* value as `this` and the key as
   the argument. The flattened plain object has no `toJSON` method (methods
   are not struct fields), so it is never called. (Affects Date, BigInt
   wrappers, custom `toJSON`.)
2. **Replacer `this` = the live holder** — §25.5.2.2 step 3 calls the
   replacer with `this` set to the holder object and `(key, value)`. After
   flattening, the holder identity is a throwaway plain object, not the
   user's live struct, so `replacer-function-arguments.js` (which asserts on
   `this` identity and call order) fails.
3. **Wrapper `[[PrimitiveValue]]`** — `new String()/new Number()/new
   Boolean()` wrappers must be unwrapped per §25.5.2.2 steps 4–6 *after*
   `toJSON`. Flattening drops the wrapper brand, so `value-tojson-*.js` and
   wrapper tests fail.
4. **Cycle detection** — §25.5.2.2 requires a TypeError when a value is
   already on the serialization stack. Detection must run over the *live*
   graph during the recursive walk; the eager flatten neither detects cycles
   (it would infinite-loop or pre-resolve them) nor preserves identity for a
   stack check.
5. **String escaping / marshaling count** — `value-string-escape-ascii.js`
   shows a string-marshaling count mismatch at the boundary independent of
   the above.

### Why this is NOT a localized `runtime.ts` patch

A correct fix requires implementing **`SerializeJSONProperty` recursion over
live values** (Wasm-side or a faithful host-side walk that can call back into
Wasm for each node), so that `toJSON`, the replacer `this`/holder, wrapper
unwrapping, and cycle detection all observe the original value at each step —
instead of a pre-flattened copy. That, in turn, depends on a reliable
**JS↔Wasm closure-marshaling boundary** for the per-node replacer/`toJSON`
callbacks (no general JS-callable Wasm function-ref trampoline yet —
**#1308 / #1382**). Net: this is a cross-cutting serialization-model change,
not a patch to `_wasmToPlain` or the `__json_stringify` import.

## Escalation — needs architect spec

Routing this to an architect (`/architect-spec`) to design the
`SerializeJSONProperty`-over-live-values lowering. The spec should cover:

- Where recursion lives (Wasm-native `SerializeJSONProperty` vs host walk that
  calls back into Wasm per node) and how it interacts with the existing
  `_wasmToPlain` fast path for the common no-replacer/no-`toJSON` case.
- The JS↔Wasm callback boundary for replacer + `toJSON` (depends on
  **#1308 / #1382** closure marshaling — call out the dependency explicitly).
- Wrapper-object `[[PrimitiveValue]]` unwrap order vs `toJSON`.
- Cycle detection over live values (stack of seen holders).
- Whether to keep the flatten path as the standalone/pure-Wasm route (#1324)
  and only take the live-value path in JS-host mode, or unify both.

**Recommendation:** do NOT attempt a speculative partial fix at the boundary
— without the live-value walk it cannot move the four acceptance-criteria
tests and risks regressing the currently-passing flatten path. Hold for the
architect spec.

## Dependencies

- **#1308 / #1382** — JS↔Wasm closure marshaling (replacer + `toJSON`
  callbacks must be JS-callable with correct `this`).
- **#1324** — pure-Wasm JSON (the standalone-mode counterpart; the spec
  should decide whether the two paths unify).

## Acceptance criteria (unchanged)

1. `built-ins/JSON/stringify/replacer-function-arguments.js` passes.
2. `built-ins/JSON/stringify/value-tojson-{primitive,object}.js` passes.
3. `built-ins/JSON/stringify/replacer-array-{normal,non-normal}.js` passes.
4. Pass-rate for `built-ins/JSON/stringify` rises from 27% to ≥75%.

### Test262 sample (verified failing on current main, 2026-05-27)

- `test262/test/built-ins/JSON/stringify/replacer-function-arguments.js` — null-deref / holder-`this` lost
- `test262/test/built-ins/JSON/stringify/value-tojson-object.js` — `toJSON` never called
- `test262/test/built-ins/JSON/stringify/value-string-escape-ascii.js` — string-marshaling count mismatch
- `test262/test/built-ins/JSON/stringify/replacer-array-normal.js`
