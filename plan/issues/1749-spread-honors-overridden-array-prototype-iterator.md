---
id: 1749
title: "Array spread `[...arr]` / spread-call must honor overridden Array.prototype[Symbol.iterator]"
status: done
created: 2026-05-30
updated: 2026-06-03
completed: 2026-06-03
priority: low
feasibility: medium
task_type: feature
area: codegen, runtime
language_feature: array-object-identity, spread, iterator-protocol
goal: object-representation
sprint: 58
parent: 1719
related: [1719, 1320]
---
# #1749 — Spread must drive the (possibly overridden) Array iterator

## Problem

Split out of #1719 (CPR — Compiled Prototype Record). The #1719 work landed the
read-drive for all four **destructuring** contexts (declaration, for-of-head,
parameter, assignment) so array destructuring now honors a monkeypatched
`Array.prototype[Symbol.iterator]` / `Array.prototype.values` override. **Spread**
(`[...arr]`, `f(...arr)`, `new C(...arr)`) is a separate consumer of `GetIterator`
and was NOT part of the 71 `*-iter-val-array-prototype.js` destructuring fails, so
it was deliberately left out of the #1719 PRs.

Spread over an array whose prototype iterator is overridden still takes the static
backing-store fast path and ignores the override — same root cause as #1719, but a
different emit site.

## Why this is genuinely out of the original 71

The 71 tests #1719 closed are all array-**destructuring** patterns. Spread is a
distinct grammar production with its own codegen path; none of the 71 exercise it.
This is tracked as a follow-up, not a regression.

## Fix direction

Reuse the already-proven CPR read-drive helper
`emitArrayProtoIteratorDrive` (`src/codegen/expressions/proto-override.ts`) at the
spread-element emit site, gated identically behind
`ctx.arrayIteratorMaybeOverridden && arrayIteratorOverrideGlobalIdx(ctx) !== undefined`.
The drive yields an iterator externref; drain it with `__iterator_next` collecting
elements into the spread target (array literal build / call-argument vector). The
gate keeps override-free modules byte-identical, exactly as the four dstr contexts do.

## Acceptance

- `Array.prototype[Symbol.iterator] = function*(){ yield 42 }; const a = [...[1,2,3]];`
  → `a` reflects the override, not `[1,2,3]`.
- Override-free spread emits byte-identical Wasm (no regression on
  `tests/equivalence.test.ts`).

## Source

Carved from #1719 "CPR-2 remaining" follow-up list (see #1719 issue file, CPR
completion section). The #1719 destructuring cluster is done; this is the next
incremental consumer.

## Implementation (done 2026-06-03)

**Emit site**: `compileArrayLiteral` spread-source loop in
`src/codegen/literals.ts`. When `ctx.arrayIteratorMaybeOverridden &&
arrayIteratorOverrideGlobalIdx(ctx) !== undefined`, the wasm-vec spread source
is driven through the #1719 `emitArrayProtoIteratorDrive` helper
(`__drive_proto_iterator` → `__call_fn_method_0`) to obtain the
override-produced iterator externref, then drained step-by-step via
`__iterator_next` into a growable WasmGC vec (doubling capacity, `array.copy`
on grow) of the result element type, and treated as a materialized spread
source — identical accumulation/fill as the existing externref-spread branch.

**Why `__iterator_next` and not `__array_from_iter` / `__iterator_rest`**: the
override generator compiles to a *WasmGC* generator whose `.next` is reached
through the wasm-struct dispatch (`__call_next` / `__sget_*`).
`__array_from_iter` / `__iterator_rest` only walk a JS-callable `.next`, so they
silently yield an empty array for a wasm-struct iterator. `__iterator_next` is
the only host import that resolves the wasm-struct iterator, exactly as the
#1719 destructuring read-drive uses it.

**Latent infra fix** (`src/codegen/registry/imports.ts`):
`fixupModuleGlobalIndices` did not shift the `protoOverrides` records' absolute
`globalIdx` when a late `string_constants` import was inserted. Reading a spread
result (`a[0]`) adds a "Cannot access property" string global, which shifted the
override slot out from under the captured index — the read-drive then read a
stale/null slot and the override was silently ignored (and in the multi-source
case produced an `immutable global cannot be assigned` validation error). Added
`protoOverrides` to the same index-shift discipline as the other module-global
maps.

**Ordering fix**: the element-coercion template (which may register
`__unbox_number`) is now built + flushed BEFORE `emitArrayProtoIteratorDrive`
emits its `call`, and `__iterator_next`'s funcIdx is re-read post-flush — so a
coercion-triggered late import can't shift the drive's funcIdx out from under
the emitted call.

**Out of scope (pre-existing, NOT regressed)**: `f(...arr)` / `new C(...arr)`
spread-CALL over a *non-literal* array already fails to compile on `origin/main`
(`not enough arguments on the stack`) independent of any override — a separate
call-spread limitation, not this issue.

## Test Results

`tests/issue-1749.test.ts` — 7/7 pass:
- `[...[1,2,3]]` single-yield override → length 1, value 42 (acceptance)
- override reading `this[i]` → array's own elements + extra value
- spread mixed with literal head/tail elements
- `Array.prototype.values` override drives spread (§23.1.3.36 alias)
- termination (override fires once at the spread boundary, no re-entrancy)
- override-free spread reads the backing store
- override-free spread emits no drive / override global / iterator import
  (structural byte-identity guard)

Regression guards (all green):
- `tests/issue-1719-cpr.test.ts`, `tests/issue-1719-s1.test.ts`,
  `tests/issue-1320.test.ts`, `tests/symbol-iterator-protocol.test.ts` — 26/26
- full `tests/equivalence/` suite — exit 0 (byte-identical for override-free)

## PR #1102 CI "50 oob regressions" — confirmed stale-baseline drift (2026-06-03)

CI run 26902102882 reported net -14 pass with 48 `oob` + 1 `other` + 1
`negative_test_fail` "regressions". Investigation proves these are NOT caused
by this PR — they are drift against a 136h-old baseline (commit 9ee8e92,
2026-05-29) vs current main HEAD (5258a136, 2026-06-03). The report itself
warns the baseline is stale.

Evidence (each of the 50 regressed test paths compiled through the exact CI
incremental path — `createIncrementalCompiler` + `wrapTest`, the
`compiler-fork-worker.mjs` contract):
- **Branch HEAD (post merge of origin/main): 50/50 compile clean, 0 fail.**
- **origin/main HEAD: 50/50 compile clean, 0 fail** (identical — so neither tip
  produces the `compile_error` the stale baseline recorded).
- **No cross-test state leakage**: compiling an override-spread test first
  (exercises the new `emitArrayProtoIteratorDrive` path) then all 50 regressed
  tests in the SAME incremental compiler instance → still 50/50 clean. The
  `protoOverrides` index-shift + driver-reservation do not corrupt subsequent
  modules.
- The 48 regressed tests (Math.tan, Date, RegExp, String, Set, …) contain no
  array spread and no `Array.prototype[@@iterator]` override, so the gated new
  path (`arrayIteratorMaybeOverridden && overrideGlobalIdx!==undefined`) never
  fires for them.

The `tests/spread-rest.test.ts` unit failures (`Import #0 "string_constants":
module is not an object or function`) are a pre-existing test-harness bug on
`main` (hand-rolled import object omits `string_constants`); origin/main emits
the identical imports for `[...arr]`, so this is not introduced here and the
file is not in the CI quality gate.

Resolution: merged origin/main into the branch and re-pushed to trigger a fresh
CI run against the freshly-promoted baseline. No code fix required — the PR diff
is correct and index-shift-safe.
