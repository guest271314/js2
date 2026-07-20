---
id: 3285
title: "wrapTest()'s synthetic harness silently deletes/weakens real test262 assertions instead of translating them"
status: done
assignee: ttraenkler/sendev-3303
completed: 2026-07-16
sprint: 72
created: 2026-07-15
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: test-infrastructure
goal: test-infrastructure
related: [3284, 3286, 3303, 3307]
regressions-allow:
  count: 1450
  reason: "#3285 assert_throws error-type tightening (oracle v4), coordinator-approved 2026-07-16 — honest reclassification measured on the reworked-shim dispatch run 29509287177: host 1358, standalone 814 non-excused wasm-change flips, ZERO improvements either lane (the pre-rework 111 'improvements' were #3315 corruption artifacts, confirming the flip set is now pure reclassification); residuals are 96-98% typed-assert.throws sites by message provenance. Both counts are UPPER bounds: the ctor-name whitelist fix landed after that run only reverts false fails to passes. Ceiling = worst lane 1358 + ~90 margin. Residual analysis: #3286; corruption carve-out: #3315."
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

only checks "did _anything_ throw." `assert.throws(TypeError, fn)` is test262's
standard way to assert a _specific_ error type — the majority of the spec's
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

## Progress — Slice 1 DONE (fix #1 only), #2 and #3 deferred to next window

This issue was sliced for budget. **Slice 1 (fix #1: `transformAssertThrows`
error-type threading) is implemented and validated in this PR.** Fixes #2
(`stripUndefinedAssert`) and #3 (full `strip*` inventory) are **not** done —
they are banked for a follow-up window. `status` stays `in-progress`.

### Slice 1 — what changed (test-infra only, no `src/` change)

`tests/test262-runner.ts`:

1. `transformAssertThrows` now emits `assert_throws(ErrorType, fn)` — it keeps
   `args[0]` (the expected error constructor) instead of discarding it. The
   optional 3rd message arg is still dropped. This flows through unchanged for
   the `assert.throwsAsync` → `assert_throws` → `assert_throwsAsync` rewrite
   path, so both shims get the type.
2. The synthetic `assert_throws` / `assert_throwsAsync` shims (in
   `buildPreamble`) now take `(ErrorCtor, fn)` and verify the caught error
   MATCHES the expected type before counting a pass:
   `e instanceof ErrorCtor`, then a `.name`-vs-`ErrorCtor.name` fallback. A
   wrong-but-present throw is now a real failure, not a pass.

**Why `instanceof` + `.name` fallback (confirmed by probing compiled code):**
inside the compiled test, `instanceof` against the in-module error constructor
works and correctly discriminates (including subclass — `assert.throws(Error,
…)` matches a `TypeError`), and `Test262Error` (a user class) matches too.
The `.name` fallback covers host-opaque error representations where the
in-module constructor identity isn't shared. Both are read inline in the shim
(factoring the matcher into a helper trapped on a null-pointer deref, so the
logic stays inline). `assert_throwsAsync`'s thenable-return path stays untyped
(the rejection reason can't be inspected synchronously) — a narrow, documented
limitation; the synchronous-throw path IS type-checked.

### Slice 1 — validation delta (scoped, JS-host lane)

Ran the real `wrapTest` + `buildPreamble` pipeline (`runTest262File`) over
`assert.throws`-using files, before vs after:

| scoped batch                                                                           | before pass | after pass | flipped pass→fail         | fail→pass |
| -------------------------------------------------------------------------------------- | ----------- | ---------- | ------------------------- | --------- |
| `built-ins/Reflect` + `built-ins/TypedArray/prototype/set` (116 files)                 | 62          | 45         | **17**                    | 0         |
| `built-ins/Map/prototype` + `Set/prototype` + `Array/prototype/copyWithin` (228 files) | —           | 212        | (control: 93% still pass) | —         |

The **17-test drop is expected and correct** per the acceptance criteria —
they are previously-inflated false-passes becoming real fails. All 17 are
`Reflect/**/return-abrupt-from-*` and `arguments-list-is-not-array-like`
tests: they assert a _specific_ error (`Test262Error` from a throwing
`toString`/abrupt coercion) propagates. Instrumenting the caught error in the
real wrapped run shows the compiler throws a **different named error**
(diagnostic class 20 for all 17), NOT the spec-mandated `Test262Error` — a
genuine compiler conformance gap (owned by #3284, not this test-infra fix)
that the old "any throw counts" shim silently passed. **Zero false-negatives**:
no case where a correct `Test262Error` was thrown but the matcher missed it.
The 228-file control batch (simple correct-type `TypeError`/`RangeError`
throws) stays at 93% pass, confirming correct-type throws are preserved and
the matcher does not mass-fail. Full-suite delta will be measured by CI.

## Next window (#2, #3 — NOT in this PR)

- **#2 `stripUndefinedAssert`** (`tests/test262-runner.ts:~1036`) and
  `stripUndefinedThrowGuards` (`~744`): still delete `assert.sameValue(x,
undefined)` / `if (x !== undefined) throw` outright. Route through a real
  comparison (`__extern_is_undefined` is referenced in #3284/#3282 context) or
  track as reduced-coverage — do not silently count as an unconditional pass.
- **#3 full `strip*` inventory**: sweep every `strip*` helper in `wrapTest()`,
  classify cosmetic (message-arg stripping, harmless) vs. assertion-deleting
  (e.g. the `/* stripped object identity assert */` bare-identifier-pair arm
  near `simpleExprPat`), fix/track the deleting ones.

## Landing notes (2026-07-16, sendev-3303 — how this PR clears the gate stack)

This PR is the first user of the #3303 `regressions-allow:` mechanism (see
frontmatter). Grounding for every number, so the next window doesn't have to
re-derive them:

- **Measurement**: branch `workflow_dispatch` of test262-sharded (run
  29505786797, head 8c892a4e = branch + current main), diffed locally against
  the fresh 2026-07-16 baselines with guard-identical flags. Host lane: 2614
  non-excused wasm-change reclassifications (net −2610, improvements 4).
  Standalone lane: 4520 (net −4409, improvements 111). The earlier quoted
  2615/2668 figures were host-lane-only snapshots from 7-15; the standalone
  lane is the LARGER one because standalone throws wrong-typed errors far more
  often (missing features), which the old any-throw shim counted as passes.
  The #3303 ceiling applies per-lane, so `count` must cover the worst lane.
  (Historical: the first, corruption-contaminated measurement read 2614/4520
  and drove a rejected 4650 ceiling; the reworked-shim re-measure collapsed
  it to 1358/814 with 0 improvements — see the shim-rework note below — and
  the approved ceiling is 1450.)
- **#2097 high-water floor — lowered 24033 → 23515 in this PR as a ONE-TIME,
  EXPLICITLY REVIEWED exception (coordinator sign-off, 2026-07-16 — recorded
  in PR #3104's thread), NOT a precedent for routine in-PR floor edits.** An
  earlier self-certified draft (−3716 on corruption-contaminated data) was
  rejected and backed out; this edit is categorically different: −518
  (−2.2 %) backed by the bucketed 96-98%-clean root-cause analysis, zero
  over-50 standalone buckets, the corruption theory independently confirmed
  by the collapse pattern, and the residue carved out to #3315. The
  chicken-and-egg is structural: the merge_group re-validates PRE-merge, so
  the sanctioned post-merge `--update` reseed cannot unblock this class of
  honest floor drop. Mark provenance: measured `host_free_pass` 23515
  (official 23280/43106) from run 29509287177 at bc2af07e; the file's `sha`
  field records that head. The measured value is a LOWER bound (the
  ctor-name whitelist fix landed after that run only converts false fails
  back to passes), so the mark is conservative and post-merge `--update`
  resumes ratcheting it upward immediately. Follow-up noted in #3303: the
  #2097 mechanism should eventually grow a proper reviewed-exception path
  (like #3303 built for the regression-count gates) instead of ad hoc in-PR
  edits.
- **ctor-name whitelist (post-re-measure fix)**: the first side-channel
  emission stringified ANY simple identifier — but a test-local ctor VARIABLE
  (`expectedError`, `DummyError`, …) is not the error's `.name`, so 132 host
  - 67 standalone flips were FALSE fails (`e.name === "expectedError"` can
    never hold). Emission now resolves a name literal only for the known global
    error constructors (+ `Test262Error`); variable-ctor sites stay
    legacy-untyped (resolving them would require evaluating the ctor in the
    method body — the #3315 trigger). Probes post-fix: all four family tests
    pass, including the DataView resizable-buffer residue case — part of the
    earlier ~45 sameValue residue dissolved with this fix, further shrinking
    the true residue attributable to #3315.
- **classifyError trap false-positive (fixed here, same v4 bump)**: the
  tightened shim embeds the original test source line in "returned N — assert
  #X at LY: <source>" failure messages; quoted text like "out of bounds" hit
  the trap regexes and mis-binned honest assertion fails as uncatchable traps
  (live instance: Temporal/Duration/subtract/result-out-of-range-1 counted as
  a NEW oob and false-tripped the allowance-immune #3189 ratchet). Fix:
  classify the `^returned` wrapper-protocol shapes BEFORE the trap patterns
  (a genuine trap can never produce a "returned N" message). Label-only — no
  pass/fail flips; 19 pre-existing mislabeled host rows also self-correct.
  Projected post-fix trap growth vs today's baseline: host oob +3 (the known
  #3202 BigInt `TypedArray.prototype.set` flap, within the tolerance-4 repo
  var), everything else shrinks.
- **Shim rework (2026-07-16 second round, coordinator-approved)**: the
  original two-arg `assert_throws(ErrorCtor, fn)` form deterministically
  triggered **#3315** — a pre-existing standalone codegen bug where ANY
  class-as-value in the method body (2nd argument, matcher closure, or even a
  global ctor assignment) silently corrupts sibling destructured bindings in
  the enclosing method. The shim now threads the expected type through a
  GLOBAL NAME side channel (`__expected_throw_name = "TypeError";
assert_throws(fn);` — the only A/B-validated clean shape) with a strict,
  guarded name check (nameless/null payloads fail honestly instead of
  crashing the harness — fixes the 9 standalone + 13 host "Cannot access
  property on null at 81:21" flips); the preamble `Test262Error` gained a
  `name` field so the poisoned-iterator dstr-err family verifies; complex
  ctor EXPRESSIONS (3 corpus tests) stay legacy-untyped (evaluating them
  would re-trigger #3315). Probe results on the reworked shim (standalone):
  corruption repro `meth-obj-ptrn-prop-ary` RET=1 (assert #2 clean AND the
  typed check passes); `gen-meth-static-ary-ptrn-elem-id-iter-val-err`
  (Test262Error family) RET=1; `non-bigint64-typedarray-throws` RET=1 — its
  earlier "honest correction" fail was itself a #3315 corruption artifact
  (clean codegen restores correct evaluation order and the real TypeError);
  `obj-id-put-unresolvable-strict` fails honestly (returned 2) instead of the
  harness TypeError; `await assert.throwsAsync` splice verified
  syntactically and behaviorally (await-using probe RET=1).
- **#3307 dependency**: the guards' diff must run at the same
  `TRAP_RATCHET_TOLERANCE` as the regression-gate job or the oob flap's
  exit 1 re-litigates the raw count and vetoes the allowance in the guards.
  PR #3137 (2 env lines) must be on main before this PR enqueues.
- **Enqueue checklist**: #3137 merged → re-merge origin/main here → CI green →
  coordinator confirms → remove the bot park-hold (diagnosed: the 7-15
  auto-park is exactly the reclassification this PR declares) → single
  enqueue. If the merge_group reports a residual above 4650, do NOT raise the
  number blindly — re-measure and re-declare honestly (ceiling semantics).
