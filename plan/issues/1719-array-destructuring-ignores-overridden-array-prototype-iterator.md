---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: blocked
blocked_on: needs-architect-spec
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: destructuring-iterator-protocol
goal: test262-conformance
sprint: Backlog
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1320, 1021]
---

# #1719 — Array destructuring must use the (possibly overridden) Array iterator (71 fails)

## Problem

71 tests fail with:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

All are `*-iter-val-array-prototype.js` array-destructuring tests across
`language/expressions/{class,object,function,async-generator}/dstr/` and
`language/statements/{class,for,for-of,function,generators}/dstr/`. Each test
overrides `Array.prototype[Symbol.iterator]` (or `Array.prototype.values`) with
a custom generator and asserts that **array destructuring uses the overridden
iterator**.

## Root-cause hypothesis

ArrayAssignmentPattern / ArrayBindingPattern destructuring (§8.5.2
IteratorBindingInitialization / §13.15.5.3 DestructuringAssignmentEvaluation)
must call `GetIterator(rhs)` which reads `rhs[Symbol.iterator]` **dynamically at
runtime**. Our codegen takes a fast static path for array RHS values that
iterates the backing store directly (or calls a fixed `%Array%.from`-style
bridge) and therefore **ignores a user-monkeypatched `Array.prototype[Symbol.
iterator]`**. When the test replaces the prototype iterator with a value the
fast path doesn't recognise, the bridge reports "items[Symbol.iterator] … be a
function" instead of invoking the override.

The fix is to route array destructuring through a real `GetIterator` that reads
the live `@@iterator` method off the value's prototype chain (honouring
overrides), rather than a compile-time-specialised array walk — at least when
the static type cannot prove the prototype iterator is intact.

Spec: [§7.4.2 GetIterator](https://tc39.es/ecma262/#sec-getiterator),
[§8.5.2 IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization).

## Example failing tests

- `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/class/dstr/private-meth-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`

## Acceptance criteria

- The four example tests pass.
- The `iter-val-array-prototype` cluster drops from 71 to ≤ 10.
- No regression in the broad destructuring fixes (#1016, #1021, #1024, #1025)
  nor in #1320 (Array.from(externref) iterator bridge).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).

## Root cause — confirmed (dev-a, 2026-05-29)

Reproduced. Hypothesis confirmed; exact site pinned to
`compileArrayDestructuring` in `src/codegen/statements/destructuring.ts`.

When the destructuring RHS resolves to a **known vec or tuple struct** (the
common typed-`T[]` case — `resultType` is a `ref`/`ref_null` to a WasmGC vec
struct), control reaches the fast path at **destructuring.ts:862-876** which
stashes the struct ref and delegates to `destructureParamArray(...mode:"decl")`.
That helper walks the WasmGC **backing store directly** (`array.get` / per-field
`struct.get` on the `{length,data}` vec) — it **never calls GetIterator and
never reads `@@iterator`** off the value's prototype chain. So a
module-monkeypatched `Array.prototype[Symbol.iterator]` (or
`Array.prototype.values`) is silently ignored.

Only the **externref branch** (`compileExternrefArrayDestructuringDecl`, used
for `resultType.kind === "externref"` / unknown structs at destructuring.ts:794,
824-827, 849-852) performs a real GetIterator (RequireObjectCoercible +
`@@iterator` + `.next()`, throw-propagating, #1454). The typed-vec/tuple fast
path and the f64/i32-box path go straight to the backing-store walk.

The failing `*-iter-val-array-prototype.js` cases compile their RHS as a typed
array → hit the fast path → override ignored → wrong values or the
`%Array%.from … items[Symbol.iterator] … be a function` bridge error.

### Why this is NOT a localized fix (scope flag → architect)

The fast path is the **hot, common-case** array-destructuring lane shared by
declaration dstr, parameter dstr (`destructureParamArray`), for-of bindings,
and the loop paths. Honouring an overridden prototype iterator needs one of:

1. **Compile-time intactness gate** (preferred): a module pre-scan sets a
   `ctx`-level flag when `Array.prototype[Symbol.iterator]` /
   `Array.prototype.values` is ever assigned (or `Object.defineProperty`'d);
   when set, the vec/tuple fast-path sites coerce to externref and delegate to
   the existing `compileExternrefArrayDestructuringDecl` GetIterator lane.
   Touches `compileArrayDestructuring`, `destructureParamArray`, the param lanes,
   and for-of. Zero perf/behavior change when the flag is clear (the common
   case); full §8.5.2 fidelity when set.
2. **Always GetIterator**: drop the fast path — large perf + behavioral
   regression risk across the dstr suites #1016/#1021/#1024/#1025/#1320
   explicitly guard. Not advisable.

Either is broad codegen-core surgery on the dstr hot path, not a ~1-file change.
Per the dev guardrail this warrants an **architect spec** (precision of the
pre-scan, the for-of interaction, and the perf gate need sign-off before a dev
lands it). Spec refs: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization,
§13.15.5.3 DestructuringAssignmentEvaluation.

Repro (worktree `issue-1719-array-dstr-iterator`): override
`Array.prototype[Symbol.iterator]` with a generator yielding a *different* 3rd
value (`42`), then `const [x,y,z] = [1,2,3]` — `z` resolves to the backing
store, not the override. Direct compile confirms the typed-vec fast path is
taken (the externref GetIterator lane is never reached for a typed array RHS).
