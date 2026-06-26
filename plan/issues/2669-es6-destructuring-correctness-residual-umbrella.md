---
id: 2669
title: "ES2015: destructuring correctness residual umbrella (~696 fails — iterator-close, defaults, holes, rest across for-of/assignment/binding/params)"
status: in-progress
assignee: ttraenkler/dev-dstr2669
created: 2026-06-25
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
related: [1642, 2566, 1556, 1454, 2203, 2032, 796]
sprint: 66
---
# #2669 — ES2015 destructuring correctness residual umbrella

## Edition / impact

- **Edition:** ES2015.
- **Fail count:** **~696** — the single largest ES2015 cluster (and the largest
  cross-cutting theme in the whole suite).
- Sub-breakdown (by `/dstr/` path + `destructuring-*` feature tag):
  - `for-of/dstr` — **247**
  - `expressions/assignment` (assignment destructuring) — **131**
  - binding patterns (`let`/`const`/`var` dstr) — **91**
  - function-param dstr — **63**
  - generator/yield-in-dstr — **63**
  - object-method (`expressions/object/dstr`, class method params) — **55**
  - arrow-function dstr — **30**
  - other — **16**

Residual after a long line of done destructuring issues (#1454, #2203, #2032,
#796, #2587). Each landed a slice; this umbrella tracks the remaining tail so it
can be sliced and burned down deliberately rather than rediscovered ad hoc.

## Problem — recurring sub-patterns

1. **IteratorClose on abrupt completion** — when a destructuring step throws or
   an array pattern doesn't consume the whole iterator, `IteratorClose` must run
   the iterator's `return()`. Tests:
   `for-of/dstr/array-*-iter-*-close-*.js`, `array-elem-iter-nrml-close-err.js`.
   (Overlaps the open #1642 — for-of body-throw IteratorClose.)
2. **Default-init evaluation** — initializer evaluated **only** when the element
   is `undefined`, exactly once, with correct `initCount`/side-effect order.
   Tests: `*-ptrn-elem-id-init-skipped.js`, `*-dflt-*`.
3. **Elision / holes** — `[, , x]` must advance the iterator past elided slots
   without binding. Tests: `*-ary-ptrn-elem-ary-elision-*`.
4. **Rest element** `[...r]` / `{...r}` — must drain remaining iterator / copy
   remaining own-enumerable props; nested rest patterns.
5. **Generators as the iterated value** — eager-buffer over-consumption gives
   wrong yield/side-effect counts (open #2566).
6. **Function/method/arrow param patterns** — struct-field type mismatches and
   null-deref in param destructuring (open #1556).

Failure signatures: `assert.sameValue(initCount, 0)`, `throw new Test262Error()`
after a close assertion, `Cannot destructure 'null' or 'undefined'`,
`it.next is not a function`, null-deref in `test()`.

## Failing-test cluster (examples)

```
language/statements/for-of/dstr/array-elem-iter-nrml-close-err.js
language/statements/for-of/dstr/let-obj-ptrn-prop-id-init-skipped.js
language/statements/for-of/dstr/const-ary-ptrn-elem-ary-elem-init.js
language/expressions/assignment/dstr/array-elem-trlg-iter-elision-iter-abpt.js
language/expressions/object/dstr/meth-ary-ptrn-elem-ary-elision-init.js
language/statements/class/dstr/private-meth-ary-ptrn-elem-ary-elision-init.js
```

## Acceptance criteria

- Net reduction of the destructuring `/dstr/` failing set by **≥ 400 tests**
  across the sub-clusters above (umbrella target; slices below ship individually).
- IteratorClose runs on abrupt completion and on partial consumption.
- Default initializers evaluate iff element is `undefined`, exactly once.
- Elisions advance the iterator without binding; rest elements drain correctly.
- No regression in currently-passing destructuring tests.

## Slicing plan (route to architect for the iterator-protocol slice)

- **Slice A — IteratorClose / abrupt-completion** (folds in open #1642). hard.
- **Slice B — default-init evaluation + elision/hole iteration** (medium).
- **Slice C — generator-as-source over-consumption** (open #2566). medium.
- **Slice D — param-pattern struct-field type mismatch** (open #1556). medium.

Keep #1642, #2566, #1556 as the concrete sub-issues; this umbrella tracks the
aggregate and the remaining un-issued tail (binding patterns, object-method
params, arrow params).

## Verify-first investigation (sd-dstr, 2026-06-26) — premise correction

Branched off `upstream/main` @ `51134ae24`; fetched baseline jsonl; reproduced
samples with **fresh single-file processes** (not in-process batch).

### Verified fail count (path-based, `/dstr/` + `destructuring`)
**1499 non-pass** (not ~696): `fail` 1427, `compile_timeout` 56, `compile_error`
16. The ~696 in the title was a feature-tag-filtered subset; the path-based count
is ~2× larger. By pattern kind from the test basename: ARRAY-pattern 1043,
OBJECT-pattern 208, neither/other 247, mixed-nested 1.

### KEY FINDING — the binding-pattern codegen is already CORRECT
Minimal fresh-process probes (via `runTest262File` harness, both strict modes):

| probe | result |
|-------|--------|
| `let [a=7,b=9]=[undefined,undefined]` (default FIRES) | **pass** |
| `let [a=7,b=9]=[1,2]` (default SKIP) | **pass** |
| `var c=0;function k(){c+=1;return 5} let [a=k()]=[undefined]; assert c==1` | **pass** |
| `let [a,...r]=[1,2,3]` (rest) | **pass** |
| `let [,a,,b]=[1,2,3,4]` (elision) | **pass** |

So array default-init / rest / elision / value-present / value-skip lowering is
spec-correct. The umbrella's premise ("default-init / holes / rest binding-pattern
codegen is broken") is **largely wrong** for the WasmGC host path.

### ROOT CAUSE of the dominant failure cluster — closure-capture box lazy-init
The standard test262 dstr template declares a **captured counter**:
`var initCount=0; function counter(){ initCount += 1 }`. `initCount` is captured
& mutated by a nested function, so it is boxed into a ref cell
(`$__ref_cell_f64`). The box (`struct.new` + `local.tee __boxed_initCount`) is
materialized **lazily at the first call site** of `counter`, in
`src/codegen/expressions/calls.ts` (the `nestedFuncCaptures` mutable-capture
branch, ~L12359–12383): it does `local.get <outer>; struct.new <refCell>;
local.tee <box>` and then re-aims `localMap[name]` to the box for **all**
subsequent reads/writes.

The bug: that `struct.new` is emitted into **whatever body buffer is active**,
which for a destructuring default is the conditional `then`-branch of the
`__extern_is_undefined` / sNaN check (`emitDefaultValueCheck`,
`src/codegen/statements/destructuring.ts`). When the element is present the
default arm does **not** execute at runtime → the box is never created → it
stays `ref.null` → every later read of the captured var (incl. the test's final
`assert.sameValue(initCount, 0)` and even plain value reads) dereferences a null
ref cell and yields the sNaN→`NaN` sentinel. Test fails.

**This is NOT destructuring-specific.** Confirmed minimal repro with a plain
conditional, no destructuring at all:
```ts
export function test(): number {
  var c = 0;
  function k() { c += 1; }
  if (c > 100) { k(); }   // not-taken branch — only call site to k
  return c;               // reads through the never-created box → NaN
}
// returns NaN, should return 0
```
The dstr default-init tests are simply the **largest surface** of a general
closure ref-cell materialization defect: *a mutable captured variable's box is
created lazily at the first capturing call site; when that site is a
conditionally-skipped branch, the box is never created and all reads corrupt.*

### Fix direction (and why it needs care — prior regressions)
Correct fix: materialize the box **eagerly at the variable's declaration** (or at
the nested-function-declaration point, which is where `ctx.nestedFuncCaptures` is
populated — `src/codegen/statements/nested-declarations.ts:764`), unconditionally,
so `localMap`/`boxedCaptures` re-aim and the box exist before any conditional use;
the call site then just `local.get`s the existing box. **This is the exact area
that regressed before** — the in-code comments at calls.ts:12361 document
#1177 Stage 1 (the `localMap.get ?? outerLocalIdx` attempt) causing **100+
test262 regressions**, and PR#166 a type-only guard causing **net −25 / 33
wasm-change regressions**. Hoisting interacts with `var`/function hoisting order
and per-iteration `for`-let box identity (closures.ts:1699–1705). So this needs
an architect spec + full `merge_group` validation, not an inline patch.

### Recommendation
- This is a **distinct, high-value, independent** (NOT substrate-gated) codegen
  root cause — recommend carving a **dedicated issue** (closure-capture box
  eager-materialization) via `claim-issue.mjs --allocate`, routed through
  architect given the #1177/#PR166 regression history. It likely unblocks a
  large fraction of the 1499 (every dstr test using the captured-counter
  template, plus general closure correctness).
- The genuinely destructuring-specific residual buckets remain the existing open
  sub-issues: **#1642** (for-of IteratorClose on abrupt completion, ~129
  iterator-protocol sigs), **#2566** (generator-as-source eager-buffer
  over-consumption — e.g. `let [[,]=g()]=[]` over-runs the generator), **#1556**
  (param-pattern struct-field type mismatch, ~153 null-deref sigs).
- Umbrella Slice B ("default-init evaluation + elision/hole iteration") should be
  **closed as already-correct** for the host path per the probes above; its
  apparent failures are the closure-box bug.

Repro driver + probes used: `.tmp/runsrc.mts`, `.tmp/runwasm.mts` (gitignored).
