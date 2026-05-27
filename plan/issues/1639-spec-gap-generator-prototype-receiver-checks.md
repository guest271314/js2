---
id: 1639
title: "spec gap: Generator/AsyncIterator prototype receiver TypeErrors + return/throw (52 + 12 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 50
renumbered_from: 1345
parent: 1328
---
# #1345 — Generator / AsyncIterator prototype: receiver checks, .return/.throw

## Problem

`built-ins/GeneratorPrototype`: **9 / 61 pass (14.8%) — 52 fails (20 type_error, 14 unreachable,
10 assertion_fail, 8 other)**.
`built-ins/AsyncIteratorPrototype`: **1 / 13 pass (7.7%) — 12 fails (7 type_error, 4 assertion_fail,
1 promise_error)**.
`built-ins/AsyncGeneratorPrototype`: **26 / 48 (54.2%) — 22 fails (17 type_error)**.

Spec §27.5.1 (GeneratorPrototype) and §27.6.1 (AsyncGeneratorPrototype) require:
1. **Brand check**: `next/return/throw` must validate `this` carries the [[GeneratorState]] internal slot;
   otherwise TypeError.
2. **State machine**: states are "suspendedStart", "suspendedYield", "executing", "completed".
3. **`.return(value)`**: from suspendedYield, run finally blocks; from completed, immediately return.
4. **`.throw(error)`**: from suspendedYield, throw inside the generator (caught by try/catch); from
   suspendedStart or completed, immediately rethrow.
5. **`%IteratorPrototype%`** is the [[Prototype]] of GeneratorPrototype.

The 14 `unreachable` failures are particularly bad — they indicate Wasm `unreachable` traps,
meaning we crash hard rather than throwing TypeError.

## Acceptance criteria

1. `built-ins/GeneratorPrototype/next/this-val-not-generator.js` passes (TypeError, no trap).
2. `built-ins/GeneratorPrototype/return/from-state-suspended-start.js` passes.
3. `built-ins/GeneratorPrototype/throw/from-state-completed.js` passes.
4. `built-ins/AsyncIteratorPrototype/Symbol.asyncIterator.js` passes.
5. Pass-rate for `built-ins/GeneratorPrototype` rises from 15% to ≥65%.
6. No `unreachable` traps in Generator tests (must be replaced by TypeError).

## Files to modify

- `src/codegen/expressions.ts` — yield/yield* lowering, generator state machine
- `src/codegen/registry/generator.ts` — generator prototype method emission

## Implementation Plan

### Root cause

The generator state machine is implemented but its prototype methods don't validate the
receiver. When called on a non-generator (e.g. `Generator.prototype.next.call({})`), we
attempt to read the state field via `struct.get` on a non-Generator struct — `ref.cast` traps
with `unreachable`.

### Approach

Insert a `ref.test $GeneratorBrand` guard at the top of each prototype method:
```
local.get $this
ref.test $GeneratorBrand
i32.eqz
if
  ;; throw TypeError("not a generator")
end
local.get $this
ref.cast $GeneratorBrand
;; ... existing impl
```

Same for AsyncGenerator and AsyncIterator (which is the prototype-of-prototypes — must exist
even though tests check just for its existence).

### Edge cases

- `.return(value)` while in `executing` state → throw TypeError (re-entrant call).
- `.throw(err)` from `suspendedStart` → just close the generator and throw (no try/catch around
  the prologue).
- Async generator: `.return()` resolves to `{value, done:true}`; `.throw()` rejects with the error.

### Test262 sample

- `test262/test/built-ins/GeneratorPrototype/next/this-val-not-generator.js`
- `test262/test/built-ins/GeneratorPrototype/throw/from-state-completed.js`
- `test262/test/built-ins/AsyncGeneratorPrototype/throw/throw-promise-rejected.js`

## Resolution (2026-05-27)

Root cause found differently from the original spec note. The brand checks on
`(Async)GeneratorPrototype.{next,return,throw}` were already present on main
(landed via #1516 / #820j as `if (!state) throw new TypeError(...)`). The two
remaining gaps were both in the *prototype chain reachability*:

1. **`g.prototype` (member access on a compiled generator-function object)
   evaluated to `undefined`** — the host can't see a compiled closure's
   `.prototype` slot, so `Object.getPrototypeOf(g.prototype)` trapped with
   "Cannot convert undefined to object" (the 14 `unreachable`/trap failures).
   Fixed by routing the member access `g.prototype` (where
   `g ∈ ctx.generatorFunctions`) to two new runtime imports
   `__get_generator_prototype` / `__get_async_generator_prototype` in
   `src/codegen/property-access.ts`. Per §27.3.3 / §27.4.3 these return a
   *fresh per-function object* whose `[[Prototype]]` is the shared
   `%(Async)GeneratorPrototype%`, so the spec walk
   `getPrototypeOf(getPrototypeOf(g.prototype))` lands one level deeper on
   `%(Async)IteratorPrototype%`.
2. **`%AsyncIteratorPrototype%` / `%IteratorPrototype%` did not exist as
   distinct objects carrying `[Symbol.asyncIterator]` / `[Symbol.iterator]`** —
   the generator protos borrowed `globalThis.(Async)Iterator.prototype` which
   is absent under Node. Added explicit `_getIteratorPrototype()` /
   `_getAsyncIteratorPrototype()` builders in `src/runtime.ts` (each installs
   the `@@(async)iterator` method returning `this`, with spec descriptors and
   name `"[Symbol.(async)iterator]"`), and chained the generator protos to
   inherit from them.

### Files changed
- `src/runtime.ts` — new `_getIteratorPrototype` / `_getAsyncIteratorPrototype`
  builders; `%(Async)GeneratorPrototype%` now inherit from them; two new
  runtime imports for `g.prototype`.
- `src/codegen/property-access.ts` — route `g.prototype` member access to the
  new imports.
- `tests/issue-1639.test.ts` — unit coverage.

### Measured impact (focused harness, JS-host eager-eval)

| Category | main PASS/FAIL/CE/TRAP | branch PASS/FAIL/CE/TRAP |
|---|---|---|
| GeneratorPrototype + AsyncIteratorPrototype | 25 / 13 / 14 / 22 | 31 / 18 / 14 / 11 |
| AsyncGeneratorPrototype | 35 / 3 / 10 / 0 | 35 / 3 / 10 / 0 (no change) |

Net +6 PASS, −11 TRAP on the target categories (the `unreachable` traps the
issue flagged as "particularly bad"). No regression in AsyncGeneratorPrototype
or in core generator iteration (for-of, manual `.next`, `yield*` — verified via
`tests/generators.test.ts` and inline smoke checks).

### Out of scope (separate pre-existing gaps)
- Wasm-side **computed Symbol member read** (`obj[Symbol.x]`) returns
  `undefined` even for own props — blocks the `verifyProperty(...[Symbol.…])`
  assertions in the AsyncIteratorPrototype tests from passing end-to-end inside
  Wasm (the prototype *structure* is correct, confirmed host-side).
- `try-catch` / `try-finally` inside generator bodies (compile errors in the
  `GeneratorPrototype/return/*` tests) — unrelated generator-codegen gap.
