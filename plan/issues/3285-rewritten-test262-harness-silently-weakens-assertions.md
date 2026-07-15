---
id: 3285
title: "wrapTest()'s synthetic harness silently deletes/weakens real test262 assertions instead of translating them"
status: ready
sprint: current
created: 2026-07-15
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: test-infrastructure
goal: test-infrastructure
related: [3284]
---

# #3285 — audit and harden `wrapTest()`'s test-body rewrite pipeline

## Scope note (read first)

This is explicitly **not** "switch `tests/test262-runner.ts` back to the real
`test262/harness/*.js` files" — that's a much bigger, separately-scoped
question, and #3284 is the issue that makes the compiler itself able to run
the real harness unmodified. This issue is scoped to the synthetic
`buildPreamble()` harness and `wrapTest()`'s test-body rewrite pipeline we
already have and intend to keep — auditing it for places where a "rewrite"
is actually a silent **deletion** of the thing being tested, and fixing those
specific spots so our own reported conformance number reflects what it
claims to.

## Problem

`wrapTest()` (`tests/test262-runner.ts:2399`) mechanically transforms every
test262 test body before compilation — renaming `assert.sameValue` →
`assert_sameValue` etc. is a reasonable, semantics-preserving translation.
But at least two of the transforms don't translate the assertion, they
**remove** it — the synthetic harness call is deleted from the source
entirely, so the test method silently contributes zero coverage instead of
either passing or failing on its own merits. A test file that exercises
exactly the removed behavior will read as passing regardless of whether the
compiler actually gets it right.

### 1. `transformAssertThrows` drops the expected error type

`tests/test262-runner.ts:672`:

```js
// args[0] = ErrorType, args[1] = fn, args[2] = optional message
if (args.length >= 2 && args[1]) {
  result += `${outputFnName}(${args[1]});`;
}
```

`assert.throws(TypeError, fn)` becomes `assert_throws(fn)` — `args[0]`, the
expected error constructor, is read out and then discarded. The synthetic
`assert_throws` (`buildPreamble`, `tests/test262-runner.ts:1630`):

```js
function assert_throws(fn: () => void): void {
  __assert_count = __assert_count + 1;
  try {
    fn();
  } catch (e) {
    return; // any throw at all counts as pass — the error's type is never checked
  }
  if (!__fail) __fail = __assert_count;
}
```

only checks "did *anything* throw." `assert.throws(TypeError, fn)` is test262's
standard way to assert a *specific* error type — the majority of the spec's
early-error and type-coercion-failure tests use this to distinguish "correctly
threw TypeError" from "threw the wrong thing" or "threw for the wrong reason."
With the type dropped, a codegen bug that throws `RangeError` instead of the
spec-mandated `TypeError` (or any other wrong-but-present error) reads as a
pass.

**Fix:** thread the error type through — `assert_throws(ErrorCtor, fn)` in the
synthetic preamble, checking `e instanceof ErrorCtor` (or a name-based
fallback for host-opaque error shapes) before treating it as pass. Same
applies to `assert_throwsAsync` (`tests/test262-runner.ts:1644`), which has
the identical "any throw/rejection counts" shape.

### 2. `stripUndefinedAssert` deletes the assertion outright

`tests/test262-runner.ts:959`, specifically the match arm at line 1036:

```js
if (secondArg === "undefined" || /^void\s+0$/.test(secondArg)) {
  // Strip the entire assert call
  ...
  result += "/* stripped undefined assert */";
  ...
}
```

`assert.sameValue(x, undefined)` / `assert.notSameValue(x, undefined)` are
removed from the compiled test body entirely — not evaluated, not converted
to an equivalent check, just gone. Any test whose entire point is "verify
this value really is `undefined`" (extremely common — e.g. checking that a
deleted/never-set property reads back as `undefined`) now has **zero**
coverage for that check and unconditionally contributes to the pass count.
Same failure mode for `stripUndefinedThrowGuards`
(`tests/test262-runner.ts:744`), which deletes
`if (x !== undefined) { throw ... }` guards rather than implementing them.

**Fix:** these two are explicitly noted in `stripUndefinedThrowGuards`'s own
comment as "not meaningful in wasm where there's no undefined type" — but the
codebase elsewhere has `__extern_is_undefined` (referenced in #3284/#3282
context) for exactly this kind of check on `any`/externref-typed values. Route
these through a real comparison instead of deleting them; where that's
genuinely not yet possible for a given operand shape, that's a compiler gap
worth its own issue (possibly folds into #3284) rather than a silent skip
here.

### 3. Lower-severity: other outright-strip sites

`tests/test262-runner.ts` has at least one more direct-delete site worth
sweeping for while in this code (`assert_sameValue(result, vals)` stripped to
`/* stripped object identity assert */` for the bare-identifier-pair shape,
near the `simpleExprPat` block) — same class of problem, smaller blast
radius. Do a full pass over `wrapTest()` for every `strip*` helper and
classify each as either "cosmetic" (message-argument stripping, harmless) or
"deletes a real check" (needs the same treatment as #1/#2).

## Why this matters

We already have a mechanism for exactly this class of false-positive risk —
the vacuity detection in `buildPreamble()` (`__harness_cb_expected`/
`__harness_cb_dead`, `tests/test262-runner.ts:1563-1581`, "a would-be pass is
VACUOUS when a wrapper was invoked and every attempted invocation was dead").
That machinery exists because a callback silently not running was recognized
as inflating the pass count. Deleting an assertion at rewrite time is the
same failure mode one layer up — the callback runs, but the check it would
have made was never emitted at all. It should get the same seriousness.

## Acceptance criteria

- `assert.throws`/`assert.throwsAsync` verify the expected error type (name
  or `instanceof`, whichever is reliably available at that point in the
  pipeline), not just "something threw."
- `assert.sameValue`/`assert.notSameValue` against `undefined` are either
  evaluated for real or explicitly tracked as reduced-coverage (not silently
  counted as an unconditional pass) — same for the `stripUndefinedThrowGuards`
  guards.
- A full inventory of `wrapTest()`'s `strip*` transforms, each labeled
  cosmetic vs. assertion-deleting, with the deleting ones fixed or tracked.
- Re-measure the JS-host test262 pass rate after these fixes — a drop is
  expected and correct (previously-inflated passes moving to fail), report
  the delta rather than treating it as a regression.
