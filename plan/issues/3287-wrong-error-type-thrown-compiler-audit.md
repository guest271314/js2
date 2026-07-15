---
id: 3287
title: "Compiler throws the wrong error type in multiple builtins — revealed by #3285 slice-1's assert.throws tightening"
status: ready
sprint: current
created: 2026-07-15
priority: high
feasibility: medium
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
goal: test262-conformance
related: [3285, 3284]
---

# #3287 — fix the compiler bugs behind the newly-failing `assert.throws` tests

## Context

#3285 slice 1 (implemented in PR #3104, currently deferred for landing-mechanism
reasons tracked separately in #3286) tightened the synthetic `assert_throws`
harness shim from "did anything throw" to "did the *correct* error type
throw" (`e instanceof ErrorCtor` + `.name` fallback). That change is a test
**scoring** fix — it doesn't touch the compiler. But scoring correctly is
exactly what surfaced this issue: ~2664-2668 previously-"passing" tests flip
to failing, and validation confirmed **0 false-negatives in the matcher
itself** — every flip is a real case where the compiled program throws a
*different* error type than the spec requires (e.g. `RangeError` where the
spec mandates `TypeError`, or vice versa). That's a genuine compiler
correctness gap, separate from and larger than the harness-scoring fix that
revealed it.

**This issue is about fixing those compiler bugs**, not about landing PR
#3104 (that's #3286).

## What's already known

From the slice-1 validation pass (scoped batches, not a full sweep):

- **Reflect + TypedArray `set`**: 62 → 45 passing after the tightened check
  (17 flips). All 17 are wrong-error-type throws, not false test failures.
- **Map/Set/`Array.prototype.copyWithin`** (control group): 212/228 (93%)
  unaffected — most `assert.throws` call sites in this area already throw
  the correct type, so the gap is concentrated, not uniform across the
  builtin surface.
- Flip buckets seen in the #3104 merge_group run (from the CI regression
  report, useful as a starting map of *where* the wrong-type throws
  concentrate, though this run mixes in the harness-scoring change itself so
  treat bucket names as leads, not a final list):
  - `class`/destructuring: 168
  - `Temporal`-adjacent prototypes: 63-115 (note: Temporal itself is
    out-of-scope/skip-filtered per the test262 runner's skip list — if this
    bucket is really Temporal, re-verify it isn't a skip-filter miss before
    spending time on it)
  - `object`/destructuring: 84
  - `async-generator`/destructuring: 56

None of the above is a verified root-cause list — it's what's visible from
score deltas, not from tracing actual throw sites. First step of this issue
is turning it into one.

## Suggested approach

1. **Error-analysis harvest first** (see [[reference_error_analysis.md]] for
   the project's established pattern): re-run the #3104 branch's test262
   batch and bucket every new fail by (expected error type, actual error
   type, source builtin/operation). This turns "2664 anonymous flips" into a
   ranked list of distinct root causes — likely a handful of throw sites
   account for most of the volume (e.g. one bad `TypedArray` bounds-check
   throwing `RangeError` instead of `TypeError` could account for dozens of
   tests on its own).
2. For each distinct root cause, trace the actual throw site in
   `src/runtime.ts` / `src/codegen/*` against the relevant tc39 spec section
   (per [[feedback_spec_first_fixes.md]] — cite the section) and fix the
   error type at the source, not in the test harness.
3. Slice fixes by root cause, not by test count — a single throw-site fix
   likely closes many tests at once, so this should decompose into several
   small, well-scoped sub-issues once the harvest identifies them, rather
   than one large PR.

## Relationship to #3286 — fix this FIRST if at all possible

#3286 is purely a CI/baseline-landing-mechanics problem: how does the
*already-correct* #3285 slice-1 scoring fix get merged despite tripping the
regression guards. This issue (#3287) is the actual compiler-correctness
work the scoring fix exposed. Fixes here don't require #3104 to be merged
first — validate locally against #3104's branch harness, or against a
hand-rolled `assert.throws(ErrorType, fn)` probe independent of the harness
entirely.

**Sequencing matters**: landing these fixes on `main` *before* #3104's
harness-tightening PR lands means those tests go straight from "wrong type,
scored pass under the old lenient check" to "correct type, scored pass under
the new strict check" — a `pass→pass` transition with no flip, invisible to
the regression gates. That sidesteps #3286's entire lever-dance problem for
however many tests this issue covers; only the uncovered residual would
still need #3286's landing-path work. Prioritize breadth of coverage here
(even partial) over waiting for a "complete" fix — every root cause closed
here shrinks #3286's blast radius.

## Acceptance criteria

- Error-analysis harvest completed and committed (bucketed by root cause,
  not raw test count).
- At least the top 3 root-cause buckets (by test count) fixed with the
  correct spec-mandated error type at the actual throw site.
- Each fix cites the relevant tc39 spec section.
- Re-measurement after each fix shows the corresponding bucket's tests
  passing under the tightened `assert_throws` check (validate against the
  #3104 branch's harness, independent of whether #3104 itself has landed).
