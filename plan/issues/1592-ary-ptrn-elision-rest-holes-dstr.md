---
id: 1592
title: "Array pattern elision holes and rest-array in destructuring consume wrong iterator step (~305 fails)"
status: in-review
created: 2026-05-24
updated: 2026-05-27
related: 1555
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, array-pattern, for-of, for-await-of, classes
goal: spec-completeness
sprint: 56
test262_fail: 305
test262_category: language/statements/class/dstr, language/statements/for-await-of, language/statements/for-of, language/expressions/class/dstr
---
# #1592 — Array pattern elision holes and rest-array in destructuring

## Problem

**305 test262 failures** across class destructuring, for-of, for-await-of, and function-parameter contexts where:

1. **Elision holes** in an array binding pattern (`[, x]`, `[a, , b]`, `[...rest, ,]`) — the iterator step for the elided slot is not consumed, so subsequent bindings read the wrong value
2. **Rest-of-array** patterns with elision (`[...ary]` where the source has holes) — similar miscount

### Error patterns observed

```
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C_method() ← test]

test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C___priv_method() ← test]

test/language/statements/for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js
  returned 2 — assert #1 at L86: assert.sameValue(first, 1);

test/language/statements/for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js
  returned 2 — assert #1 at L67: assert.sameValue(iterations, 1);
```

### Category breakdown (2026-05-24 run, excluding illegal_cast)

| Category | ~Count |
|----------|--------|
| `language/statements/class` (dstr) | ~72 |
| `language/expressions/class` (dstr) | ~72 |
| `language/statements/for-await-of` | ~42 |
| `language/expressions/object` (dstr) | ~34 |
| `language/expressions/async-generator` (dstr) | ~14 |
| `language/statements/for` | ~12 |
| `language/statements/for-of` | ~9 |
| `language/statements/function` | ~9 |
| other | ~41 |

### Root cause hypothesis

`destructureParamArray` (or the equivalent `decl-mode` path after #1553a–d) consumes iterator steps for each binding element in turn. For elision positions, the spec (§13.3.3.8 IteratorDestructuringAssignmentEvaluation step 2: "If BindingElementList contains an elision, call IteratorStep") requires calling `IteratorStep(iterator)` and discarding the result. Our implementation likely skips the `IteratorStep` call for elision positions entirely, meaning subsequent bindings read one-ahead values, and rest/empty patterns receive a null or undefined instead of the remaining iterator.

The `Cannot destructure 'null' or 'undefined'` error on the first binding of a class method (L8) suggests the iterator itself is being passed null where the caller expects an iterable — possibly the method-default parameter elision path doesn't thread the iterator through correctly.

## Acceptance criteria

- `[a,,b] = iter` leaves a one-step gap (spec §13.3.3.8 step 2b)
- `[...rest] = iter_with_elision_source` collects all remaining values correctly
- All ~305 listed test262 files pass
- No regressions in equivalence or existing dstr tests

## Notes

- Spec reference: ECMA-262 §13.3.3.8 ArrayBindingPattern evaluation, steps for BindingElisionElement

## Investigation 2026-05-27 (dev) — DUPLICATE OF #1555, root cause confirmed

Reproduced both failure shapes against the real test262 harness (worktree
`issue-1592-elision-rest`, branch from main 5932eef61):

1. `class C { method([,]) {} }; new C().method(g())` → assertion fails
   (`second` becomes 1, expected 0). The single-elision pattern `[,]` must call
   `IteratorStep` exactly ONCE (spec §12.14.5.3 Elision step). We instead
   **materialise the whole generator** via `__array_from_iter`, draining it to
   completion (`first=1, second=1`).
2. `class C { method([...[,]] = g()) {} }; new C().method()` → runtime
   `Cannot destructure 'null' or 'undefined'`. Generator-default path only;
   the same `[...[,]]` pattern with a **plain-array** arg or **plain-array**
   default (`= [9,8,7]`) both PASS. So the null leak is in the
   `__array_from_iter` materialisation of the generator default, not the rest
   logic itself.

Both failures share ONE root cause: `destructureParamArray`
(`src/codegen/destructuring-params.ts`) materialises the entire iterator into a
vec via `__array_from_iter` before binding. This over-consumes iterators with
observable side effects (generators with statements between yields). The
`isPatternEmptyOnly` guard only short-circuits length-0 `[]`, so elision-only
patterns (`[,]`) still materialise fully.

**This is exactly the repro and root cause already tracked by #1555**
(`refactor: destructureParamArray — streaming IteratorStep-per-element instead
of __array_from_iter materialisation`, `feasibility: hard`,
`reasoning_effort: max`, Backlog). #1592 is the test262-failure-count view of
the same defect. It is NOT fixable with a localised codegen patch — a partial
fix would fight the #1555 streaming rewrite and risk regressing the tuned
#1432/#1450/#1550 empty/elision/default handling.

**Recommendation**: fold #1592 into #1555 (or mark #1592 blocked-on #1555).
The streaming-iterator refactor is the correct, single fix for the whole
~305-test bucket. Escalation tag on the task was correct — this needs the
architect's #1555 streaming design, not a dev hotfix.

## Implementation (dev, 2026-05-27) — bounded-helper Phase 1

Implemented the incremental bounded-materialization fix (architect's Phase-1
plan), NOT the full #1555 streaming rewrite.

### Changes
- **`src/runtime.ts`**: refactored the `__array_from_iter` closure body into a
  shared `_arrayFromIter(obj, limit)` and added `__array_from_iter_n(obj, n)`
  (n<0 ⇒ `limit = Infinity`, byte-identical to the old unbounded drain; n≥0 ⇒
  consume at most `n` IteratorStep calls). Default-array slice fast path, a new
  bounded `_drainIterable` (replaces `Array.from` so a finite bound stops
  early), and a bounded break in the wasm-closure manual walk.
- **`src/codegen/destructuring-params.ts`**: exported
  `patternIteratorStepCount(elements)` (elisions count, rest ⇒ -1); the
  externref param/decl fallback now imports `__array_from_iter_n` and pushes
  `f64.const stepCount` before the call.
- **`src/codegen/expressions/assignment.ts`**: array-assignment-pattern
  materialization swapped to `__array_from_iter_n` with the same step count.

### IteratorClose correction (vs the architect note)
The architect plan said a bounded stop must NOT close. That is wrong for a
**no-rest** pattern: §8.5.3 calls IteratorClose after the last element because
`iteratorRecord.[[Done]]` is still false. Verified against native V8 and against
test262 `*-ary-init-iter-close.js` (next×2 → return×1 for `[a,b]`; `[x]` over a
never-done iterator → return×1). So the bounded break sets `cappedOut = true`
→ closes. Natural `done:true` before the bound still does NOT close (matches
`*-ary-init-iter-no-close.js`); rest patterns drain unbounded and never close.
This made the existing #1219 unit test #2's `doneCallCount === 0` assertion
(tuned to the old eager over-read) spec-incorrect — updated to `=== 1`.

### Scope / residual
The two patched sites (function/class-method params, decl-var, array
assignment) are fixed: plain-object iterators consume exactly the
pattern-length steps and close per spec (verified). One residual remains, OUT
OF SCOPE for this fix: **compiled `function*` generators eagerly advance past a
yield** — `_arrayFromIter`/`_drainIterable` correctly request only N steps
(traced: one `.next()` call), but the generator host-bridge runs the body to
the *next* yield, so a `[,]` over `function* g(){first++; yield; second++}`
still observes `second === 1`. That is a generator-suspension codegen bug
(separate from iterator-step accounting) and belongs with the deeper
generator/lazy-default work (#1555 / generator codegen), as the architect noted
for the lazy-default-interleaving sub-case. The for-of-loop-LHS destructuring
(`for (let [x] of [iter])`) is a third codegen path not touched here and
remains as-is (pre-existing).

## Test Results
- New `tests/issue-1592.test.ts` — 8 cases (single/gap/trailing elision, rest,
  short source, assignment pattern, IteratorClose-on-non-done, rest no-close):
  all pass.
- `tests/issue-1219.test.ts` updated (test #2 → spec-correct `doneCallCount===1`)
  — all pass.
- Regression suite (1432, 1450, 1158, test262-dstr-patterns, basic/array-rest/
  generator-method destructuring, iterators, symbol-iterator-protocol,
  null-destructuring, 43-assign-dstr, 1372-ir): 82 tests pass, 0 failures.
- test262 spot-check (sync): `*-iter-no-close` pass; `*-iter-step-err` /
  `*-iter-val-err` pass; plain-object elision/close cases corrected. Async
  (`for-await-of`) and generator-source variants still fail on the residual
  above (pre-existing, not regressed). CI measures the net bucket delta.
