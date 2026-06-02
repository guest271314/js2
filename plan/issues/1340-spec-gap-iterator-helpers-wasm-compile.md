---
id: 1340
title: "spec gap: Iterator.prototype helpers wasm_compile errors (89 of 245 fails)"
status: done
created: 2026-05-08
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterator
goal: spec-completeness
sprint: 50
parent: 1328
related: 1320, 1323
resolution: "Architect spec landed and was implemented in PR #867 — function-decl closure-singleton cache (`emitCachedFuncClosureAccess`). Each captureless top-level `function foo(){}` now resolves to a single lazy-init externref global at every value-context read, so `(foo as any).prototype = X` round-trips and the test262 Iterator-shim no longer misclassifies as wasm_compile."
---
# #1340 — Iterator.prototype helper methods: wasm_compile failures

## Problem

`built-ins/Iterator/prototype`: **128 / 373 pass (34.3%) — 245 fails (121 assertion_fail,
89 wasm_compile, 11 runtime_error, 11 type_error, 7 other)**.

The 89 wasm_compile failures stand out: this means tests are failing at compile time
(not at runtime), suggesting a type-mismatch in the IR lowering of Iterator helpers
(`drop`, `take`, `map`, `filter`, `flatMap`, `some`, `every`, `find`, `forEach`, `reduce`,
`toArray`).

Spec §27.1.4.x requires each helper to:
1. Validate `this` is an Iterator (TypeError otherwise).
2. Wrap into a new iterator that lazily applies the operation.
3. Forward `.return()` to the underlying iterator on early completion.

## Acceptance criteria

1. `built-ins/Iterator/prototype/{drop,take}/argumenttype-*.js` compile without wasm_compile errors.
2. `built-ins/Iterator/prototype/{map,filter,flatMap}/callable-fn.js` pass.
3. wasm_compile error count for `built-ins/Iterator/prototype` drops from 89 to <10.
4. Pass-rate for `built-ins/Iterator/prototype` rises from 34% to ≥65%.

## Files to modify

- `src/codegen/registry/iterator-helpers.ts` (or wherever Iterator.* is registered)
- `src/codegen/expressions.ts` — call-expression dispatch for `Iterator.prototype.X`

## Implementation Plan

### Root cause

Each Iterator helper currently emits a closure-capturing call to a polymorphic `next()` that
expects an `(ref $Iterator)` but the actual `this` may be `externref` (host-iterable, e.g.
Set entries). The Wasm validator rejects the type mismatch.

### Approach

Coerce the receiver to externref at the helper entry, and use `__iterator_next` host bridge
(or the future pure-Wasm iterator protocol from #1323). Three options:

1. **Polymorphic dispatch** at call site: check `ref.test $Iterator` first; if true, fast path;
   else externref slow path.
2. **Single externref-only path**: simplest; requires #1323 (pure-Wasm iterator protocol) for
   standalone mode.
3. **Inline lowering**: each helper expands to a generator-style state machine. Most spec-correct
   but largest code-size impact.

Recommended: option (1) for sprint 50; revisit (3) when iterator-helper hot paths show up in
benchmarks.

### Edge cases

- `this` is not an Iterator (plain object with `next`) → spec says TypeError.
- Helper's callback throws → call `IteratorClose` on underlying iterator before re-raising.
- `flatMap`'s callback returns an iterable → recursively flatten one level.

### Test262 sample

- `test262/test/built-ins/Iterator/prototype/drop/argumenttype-undefined.js`
- `test262/test/built-ins/Iterator/prototype/map/callable-fn.js`
- `test262/test/built-ins/Iterator/prototype/flatMap/inner-generator-throw.js`

## 2026-05-28 (developer) — recon + escalation

**Baseline** (test262-current.jsonl, main HEAD 38682fdbd):
- 134 pass / 239 fail (36% pass-rate, basically unchanged from sprint-50 numbers)
- Error-category split: 121 assertion_fail, **88 wasm_compile**, 12 runtime_error,
  8 other, 5 type_error, 3 null_deref, 2 range_error.

**The "88 wasm_compile" classification is misleading** — every one of the
sampled entries is a runtime `"<X> is not a function"` TypeError (drop/take/
map/filter/flatMap/some/every/find/forEach/reduce/toArray), not a Wasm
validator failure. The runner's `error_category` bucketing groups these under
`wasm_compile` because the test fails before any assertion runs. A direct
probe (compile + instantiate, no runner) of 110 sampled files in
`Iterator/prototype/{drop,take,map,filter,flatMap,some,every,find,forEach,reduce,toArray}`
showed **0 compile failures** — all 110 compile cleanly under `--target js-host`.

So this is not the IR-lowering / `(ref $Iterator)` type-mismatch hypothesis
in the sprint-50 spec. The compiler doesn't have an "Iterator helper" code
path at all — the runtime currently leans on `globalThis.Iterator.prototype`
(Node 25 provides drop/take/map/etc natively).

**Real root cause — host-bridged Iterator.prototype isn't reachable from
compiled code.** Reduced repro (no test262 harness):
```ts
function Iterator(this: any): void {}
(Iterator as any).prototype =
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

export function test(): number {
  const p = (Iterator as any).prototype;
  if (p == null) return 81;          // <-- this returns 81
  const t = (p as any).take;
  if (typeof t !== "function") return 83;
  return 1;
}
```
Returns `81` — the assignment to `(Iterator as any).prototype` does not
round-trip: reading `Iterator.prototype` back returns null. So even before
we get to "does our property-read traverse Node's `%IteratorPrototype%`?"
the *write* of `.prototype` on a function-typed compiler-declared local is
not preserved. This is the shape the test262 runner shim relies on
(`tests/test262-runner.ts:1705-1708`), so every test that uses `Iterator.X`
on a sample value crashes with `"X is not a function"`.

**A second, separate defect surfaced**: simplifying the assignment to a
host-iterable target (`(Iterator as any).prototype = [][Symbol.iterator]();`)
crashes the module *at init* with `[object Object] is not iterable` from
`src/runtime.ts:7016` — `__iterator` is being called on the RHS, suggesting
the assignment is being misrouted to a destructuring/iteration path. Same
class of bug — assignment-target evaluation on a host externref captured
into a function's `.prototype` slot is going through the wrong codegen
arm.

**Why this needs architect spec**, not a localised dev fix:
1. The issue's "Approach" (polymorphic dispatch at call site with
   `ref.test $Iterator`) doesn't address the actual defect. The compiler
   has no Iterator helper code path. Writing one is the architect's
   call (mirrors Wasm-native Map/Set in #1103/#1105).
2. The reproducer is a *property-write semantics bug* on the
   compiler-declared `function Iterator()`'s `.prototype` slot — it
   touches function-object boxing, assignment-target resolution, and
   the staticProps global path. Fixing it locally risks the same
   `__sset_` regression class that bit #1630/PR #781.
3. Alternative narrow fix — extend the runtime polyfill
   (`_installIteratorHelperPolyfills` in `src/runtime.ts:480`) to install
   the 11 missing helpers on `%IteratorPrototype%` directly — works
   without touching codegen, but does **not** help the failing tests
   because those tests read `Iterator.prototype.X` through the runner's
   shimmed `Iterator` function, and that path is the one that's broken.
   Installing on `globalThis.Iterator.prototype` is irrelevant when the
   compiler-side `Iterator` binding can't see it.
4. Acceptance criterion 3 ("wasm_compile <10") is **already roughly true
   in spirit** — the 88 entries are not Wasm-validator failures. Better
   target: pass-rate ≥65% on the cluster. That requires either (a) fixing
   the function `.prototype = ...` host-bridge round-trip, or (b) carving
   out a special compiler path that recognises the runner shim pattern
   and emits a direct global-iterator-prototype lookup.

**Recommendation**: architect spec covering option (a) — function
`.prototype` writebacks when RHS is a host externref. Once that's stable,
re-run the cluster; remaining residuals (true assertion mismatches) become
the dev-sized follow-ups (~120 fails, much narrower scope per-test).

**Worktree**: `/workspace/.claude/worktrees/issue-1340-iterator-helpers`
(branch `issue-1340-iterator-helpers`, only this doc commit so far).
No code changes.

**Related upstream defects**:
- `#1320` — Array.from iterator bridge (also blocked on architect)
- `#1665` — native generators (architect-blocked on shared $Iterator design)
- `#1644` — i64-bigint-brand (architect representation spec)

These three plus #1340 share a common need: a typed bridge between
compiler-declared "iterator-shaped" values and host iterator
prototypes. A combined spec is more efficient than four sequential
ones.
