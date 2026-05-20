---
id: 1510
sprint: 52
title: "spec gap: for-await-of destructuring — await on IteratorStep + binding initialization"
status: suspended
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: async-iteration, destructuring
goal: spec-completeness
related: [1373, 1373b, 1451, 1454]
---
# #1510 — for-await-of destructuring shape/await errors

## Problem

`language/statements/for-await-of/async-{func,gen}-{decl,dstr}-*` accounts
for **~400 failing test262 cases** with patterns like:

```js
async function f(iter) {
  for await (const [x = y, ...rest] of iter) { … }
}
```

Symptoms in test262:

- `illegal cast [in fn() ← test]` on rest patterns (~25 entries).
- `dereferencing a null pointer` on nested array elem init (~30 entries).
- `assert.sameValue(initCount, 0)` — defaults fire on the wrong branch
  (~80 entries).
- `',' expected.` on one outlier (`async-func-decl-dstr-array-elem-init-in.js`)
  — parser confusion when the `in` keyword appears inside the
  initializer of an array element inside for-await-of head.

## Failure count

**~400 fails** across `language/statements/for-await-of/`. Realistic
target after #1450/#1451 land: **250+ flips**.

## Root cause

Per ECMA-262 §14.7.5.13 (`ForIn/OfBodyEvaluation` with
`iteratorKind=async`), each `IteratorStep` call must:

1. Call `iterator.next()` returning a thenable.
2. `Await` the thenable → IteratorResult.
3. If `IteratorResult.done` is true, finalize.
4. Else extract `value`, run `BindingInitialization` on the
   pattern with `value`.

Our compiler in `src/codegen/statements.ts` re-uses the synchronous
for-of destructuring path even when `isAwait=true` is set on the
`ForOfStatement`. The await is inserted only around the *next() call
result*, not around the *binding-pattern step's individual element
reads* — so when the iterator yields an array-like that itself needs
destructuring, the inner iterator step is not awaited.

Concretely: `compileForOfStatement` (around line 1500–1700 in
`src/codegen/statements.ts`) emits `__iter_next_async(record) →
externref Promise`, awaits it once, then passes the resolved value
into a synchronous `compileBindingPattern` helper. Rest patterns
inside the binding then re-call `__iter_step` synchronously on a value
that is *itself* an async iterable — producing the illegal-cast crash.

The parser-side `'\,' expected.` failure
(`async-func-decl-dstr-array-elem-init-in.js`) is a separate fix:
inside the head of `for await`, the `in` keyword in an initializer
must be disambiguated by parenthesis depth, not by the surrounding
statement kind.

## Files to touch

- `src/codegen/statements.ts` — `compileForOfStatement` /
  `compileForAwaitOfStatement`: route binding-pattern step calls
  through an async-aware emitter that inserts an `await` on each
  `IteratorStep`.
- `src/codegen/destructuring.ts` — add an `isAwait` parameter to
  the array-pattern emitter; when set, emit `await` between
  `__iter_next` and `IteratorComplete`.
- `src/compiler/parser.ts` — disambiguate `in` inside for-await-of
  array-element initializers.

## Acceptance criteria

1. ≥ 250 tests in `language/statements/for-await-of/` flip from
   `fail` to `pass`.
2. No new regressions in synchronous `for-of` (count must not drop in
   `language/statements/for-of/`).
3. The illegal_cast bucket in `error_categories` drops by ≥ 30.

## Reference tests

- `language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-rest-ary-elision.js`
- `language/statements/for-await-of/async-gen-decl-dstr-array-elem-init-assignment.js`
- `language/statements/for-await-of/async-gen-dstr-let-async-ary-ptrn-elem-ary-rest-iter.js`
- `language/statements/for-await-of/async-func-decl-dstr-array-elem-init-in.js` (parser-side)

## Implementation Notes (Phase 1)

This PR addresses the dominant **null-pointer / silently-lost-write**
sub-category — boxed-capture assignment destructuring with default
initializers in for-await-of (and incidentally also in sync for-of).

### Root cause

In test262 patterns like

```js
let v2, vNull, vHole, vUndefined, vOob;
async function * fn() {
  for await ([v2 = 10, vNull = 11, vHole = 12,
              vUndefined = 13, vOob = 14] of [[2, null, , undefined]]) { … }
}
```

the outer `let v2, …` declarations are captured by the async generator
as **boxed ref-cells** (mutable closure captures wrapped in
`struct (field $value (mut T))`). Per spec §13.15.5.5 the destructuring-
assignment loop body must write each new value through `struct.set
$cell 0` — not via a direct `local.set` on the captured parameter.
The captured parameter holds the ref to the cell; overwriting it with
a value either:

- **Traps with `dereferencing a null pointer`** when the value's
  compiled type doesn't match the cell's pointer type (e.g. f64 default
  → `coerceType` to `ref null T` produces `ref.null T` + `ref.as_non_null`
  on a freshly-pushed null), or
- **Silently drops the mutation** — overwrites the local copy of the
  ref-cell pointer with the value, leaving the outer scope's view at
  its pre-loop value (visible in test262 as `assert.sameValue(initCount,
  0)` failures and `let v = -1` staying -1).

The pre-#1510 boxed-capture branches in `compileForOfAssignDestructuring{,Externref}`
and `compileForOfIteratorAssignDestructuring` were gated on `!defaultInit`:

```ts
const boxedCap = fctx.boxedCaptures?.get(targetEl.text);
if (boxedCap && !defaultInit) { /* struct.set on cell */ continue; }
// fall-through: emitDefaultValueCheck → local.set (wrong!)
```

The fall-through routed every default-bearing target through
`emitDefaultValueCheck` whose store is `local.set <param>` — exactly
the bug.

### Fix

For each of the three destructure-assignment emit sites in
`src/codegen/statements/loops.ts`, add a parallel boxed-capture branch
for `boxedCap && defaultInit`. The new branch:

1. Pushes the box-ref onto the stack (target of the eventual `struct.set`).
2. Extracts the candidate value (via `__extern_get` / `struct.get` /
   `array.get`, depending on the element-type path).
3. Tees into a temp, then calls the appropriate "is undefined" predicate:
   - `__extern_is_undefined` for externref elements,
   - sNaN sentinel comparison (`0x7FF00000DEADC0DE`) for f64,
   - `ref.is_null` for ref/ref_null,
   - constant false for i32 (no reliable sentinel).
4. Emits an `if (val valType) … else …` whose **then** branch compiles
   the default expression to the cell's value type, and whose **else**
   branch coerces the candidate value to the cell's value type.
5. Closes with `struct.set <refCellTypeIdx> 0` to write through the cell.

The `(val valType)` if-result keeps the value on the stack so the
trailing `struct.set` consumes `[box-ref, value:valType]` correctly.
A `global.set` post-write keeps any same-name module global in sync
(mirrors the existing `!defaultInit` boxed-capture path).

### Why this doesn't break sync for-of

The three emit sites are shared by sync `for-of` destructure-assign,
and the boxed-capture issue is identical there (a closed-over `let` in
any function — sync or async — exhibits the bug). The new branch fires
whenever `fctx.boxedCaptures?.get(targetEl.text)` is set, so we
incidentally fix the sync-for-of case too. The pre-existing
destructuring suites (`destructuring-extended.test.ts`,
`for-of-assign-destructuring-primitive.test.ts`, etc.) continue at
their baseline pass rate — the 4 unrelated pre-existing failures in
`destructuring-initializer.test.ts` / `destructuring-extended.test.ts`
were verified to fail on `origin/main` HEAD too.

### Scope explicitly NOT addressed by this PR

- **Per-element iterator protocol for inner iterables**
  (spec §7.4.6 + §13.5.7 IteratorBindingInitialization). When for-await-of
  yields a sync generator that is then array-destructured (e.g.
  test262's `…-rest-ary-elision.js`), the rest pattern already uses
  `__extern_slice` (which dispatches to `Array.from` for arbitrary
  iterables), but the leading non-rest elements still go through
  `__extern_get(obj, i)` — indexed access, not `iterator.next()`. For a
  generator `obj[i]` is `undefined`. Defaults will incorrectly fire.
  Fixing this is a larger restructuring of
  `compileExternrefArrayDestructuringDecl` (or a new "convert iterable
  to array via iterator protocol" host helper at the destructuring
  entry) and is deferred to a follow-up — it interacts with #1454's
  IteratorClose semantics.
- **Parser-side `in` keyword disambiguation** inside for-await-of
  array-element initializers. We use the TypeScript parser which
  already accepts the pattern (verified by the `accepts \`in\`…` test
  in this PR). The surface-level test262 failure (`',' expected.`)
  must originate from a different code path — left for follow-up.
- **True async/await semantics** (JSPI / stack switching). Our
  for-await-of relies on the "no-op await" model — async generators'
  results are thenables whose `.value`/`.done` are directly readable —
  and cannot model interleaved async iteration. Out of scope.

### Files touched

- `src/codegen/statements/loops.ts`
  - Imports `ensureExternIsUndefined` from `./destructuring.js`.
  - `compileForOfAssignDestructuringExternref` — adds `boxedCap &&
    defaultInit` branch.
  - `compileForOfAssignDestructuring` (vec path) — adds the same branch
    (covers `for-of` of `T[][]` shapes; primary path for typed iter).
  - `compileForOfIteratorAssignDestructuring` — adds the same branch
    (iterator-protocol path for non-array iterables).
- `tests/issue-1510.test.ts` — five test cases:
  - binding destructure with defaults via captured outer state,
  - assignment destructure with defaults (the previously-trapping case),
  - rest pattern over an array,
  - rest pattern over a yielded sync iterator,
  - parser-side: `in` keyword inside the initializer.

## Suspended Work

- **PR**: #387 — https://github.com/loopdive/js2wasm/pull/387
- **Branch**: `issue-1510-for-await-of-dstr`
- **Worktree**: `/workspace/.claude/worktrees/issue-1510-for-await-of-dstr/`
- **HEAD SHA**: `ea4919434756a22d7897f5cef805e6dc060cdb9e`
- **State**: PR pushed and open; suspended while waiting for CI to populate `.claude/ci-status/pr-387.json`.

### What was implemented (Phase 1)

Boxed-capture-with-default-initializer fix for destructure-assignment in
for-await-of (and incidentally also sync for-of). Three new branches
added to `src/codegen/statements/loops.ts`:

- `compileForOfAssignDestructuringExternref` — externref element path
- `compileForOfAssignDestructuring` (vec sub-branch) — typed `T[][]` path
- `compileForOfIteratorAssignDestructuring` — iterator-protocol path

Each emits `[box-ref, value-via-extract] tee tmp` → undefined-test
(`__extern_is_undefined` / sNaN sentinel / `ref.is_null`) → `if (val
valType) <default> else <coerce(tmp)>` → `struct.set <refCellTypeIdx> 0`.

Tests: `tests/issue-1510.test.ts` (5 cases — all pass locally). No
regressions in `destructuring-extended`, `destructuring-initializer`,
`for-of-array-destructuring`, `null-destructuring`, `issue-1258`
(verified the 4 pre-existing failures are identical on origin/main).

### Resume steps

1. Check `.claude/ci-status/pr-387.json` for CI result with `head_sha`
   matching `ea4919434756a22d7897f5cef805e6dc060cdb9e`.
2. If `net_per_test > 0`, ratio <10%, no bucket >50: self-merge with
   `gh pr merge 387 --admin --merge`, then remove worktree.
3. If regressions: re-enter the worktree at
   `/workspace/.claude/worktrees/issue-1510-for-await-of-dstr/` and
   investigate via the bucket analysis in the ci-status file.
4. Phase 2 (deferred, follow-up issue): per-element iterator-protocol
   destructuring of yielded iterables (spec §13.5.7) — interacts with
   #1454's IteratorClose. The key code site is
   `compileExternrefArrayDestructuringDecl` in
   `src/codegen/statements/destructuring.ts` (currently uses
   `__extern_get(obj, i)` indexed access; needs an Array.from-style
   normalization or a real iterator-step loop for sync iterables
   yielded by async generators).
