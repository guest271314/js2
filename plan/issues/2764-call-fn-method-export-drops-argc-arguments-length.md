---
id: 2764
title: "@@hasInstance handler invoked at unknown-arity (arguments.length wrong) — dispatcher half fixed by #2213; one-line residual"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
assignee: ttraenkler/agent-a2da3f181c62e4768
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: arguments
goal: core-semantics
parent: 2740
depends_on: []
related: [2213]
---
# #2764 — host method-bridge closure dispatch leaves `arguments` length stale

Split of the #2740 umbrella. A general correctness bug (not instanceof-specific)
surfaced by the instanceof `Symbol.hasInstance` test.

## ✅ STATUS 2026-06-28: dispatcher half RESOLVED by #2213; residual is a verified one-liner

Originally: a Wasm closure invoked from the host through the **method** dispatch
bridge (`__call_fn_method_<N>`) built its `arguments` object from a **stale**
`__argc` global. The non-method bridge (`__call_fn_<N>`,
`emitClosureCallExportN`) sets `__argc`/`__extras_argv` before its `call_ref`
(#820l); the method bridge (`emitClosureMethodCallExportN`,
`src/codegen/index.ts`) did not.

bind's **#2213** (merged to `main`) added the `__argc`/`__extras_argv` setup to
`emitClosureMethodCallExportN` — exactly the dispatcher gap flagged here.
Re-verified against current `main` (post-#2213 merge): the method export now
sets `__argc` correctly.

**Remaining residual — small and VERIFIED.** With #2213 in place,
`language/expressions/instanceof/symbol-hasinstance-invocation.js` still fails
(`arguments.length === 4`) ONLY because `_instanceofResult` (`src/runtime.ts`)
bridges the `@@hasInstance` handler via `_maybeWrapCallableUnknownArity`, which
dispatches the `this`-bound handler through `__call_fn_method_<maxArity>` (=4);
`__argc` is then (correctly, post-#2213) set to 4. Per §13.10.2 step 4a the
handler must be called with **exactly one** argument. Bridging it at known arity
1 routes it through `__call_fn_method_1` → `__argc === 1`.

Verified fix — in the `@@hasInstance` branch of `_instanceofResult`, replace the
`_maybeWrapCallableUnknownArity(handler, …)` bridge with a known-arity-1 bridge:
```ts
// recover the raw closure (the property read may already have wrapped it) and
// re-bridge at the spec-mandated arity 1
const rawHandler = typeof handler === "function" ? (_wasmClosureWrapperTargets.get(handler) ?? handler) : handler;
const wrappedHandler = _maybeWrapCallable(rawHandler, 1, callbackState);
const hfn = typeof wrappedHandler === "function" ? wrappedHandler : typeof handler === "function" ? handler : undefined;
```
Confirmed locally on current main (cache cleared): with this change
`symbol-hasinstance-invocation.js` PASSES (`arguments.length === 1`,
`args[0] === 0`, `thisValue === F`, `callCount === 1`), and the other three
`symbol-hasinstance-*` tests stay green.

## Acceptance criteria
- `symbol-hasinstance-invocation.js` passes (`arguments.length === 1`, `args[0] === 0`, `thisValue === F`, `callCount === 1`).
- No regression in `symbol-hasinstance-not-callable` / `-to-boolean` / `-get-err` (all green) or other closure/arguments tests.

## Notes
- This is a broad-impact runtime change (the dynamic instanceof path), so land it
  via its OWN PR with **full test262 CI** validation (`project_broad_impact_validate_full_ci`),
  not folded into a docs PR.
- Reproduction-harness gotcha: the test262 runner caches compiled wasm by source
  SHA + a `compilerHash` that covers `runtime.ts` but NOT `src/index.ts`. When
  iterating on `index.ts` codegen, clear `.test262-cache/` (or touch
  `runtime.ts`) or the runner serves stale wasm and your change appears to no-op.
- Sites: `src/runtime.ts` `_instanceofResult` (~2215, the residual fix);
  `src/codegen/index.ts` `emitClosureMethodCallExportN` (dispatcher, fixed by
  #2213) vs `emitClosureCallExportN` (the reference);
  `src/codegen/statements/nested-declarations.ts` `emitArgumentsVecBody`.

## Resolution (2026-06-28)
Applied the documented one-liner in `_instanceofResult` (`src/runtime.ts`):
recover the raw wasm closure from `_wasmClosureWrapperTargets` and re-bridge the
`@@hasInstance` handler at the spec-mandated known arity 1 (via
`_maybeWrapCallable(rawHandler, 1, …)` → `__call_fn_method_1` → `__argc === 1`)
instead of the unknown-arity max bridge.

Verified on current `main` (cache cleared) via the test262 harness:
- `symbol-hasinstance-invocation.js`: fail → **pass**
- `symbol-hasinstance-not-callable.js` / `-to-boolean.js` / `-get-err.js`: stay **pass**

Added `tests/issue-2764.test.ts` (5 `assertEquivalent` cases: `arguments.length
=== 1`, `args[0] === V`, `this === F` + `callCount === 1`, named-param binding,
ToBoolean-coercion regression) — all green; `tests/issue-2702.test.ts` (8) stays
green.
