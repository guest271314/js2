---
id: 3135
title: "standalone `undefined + x` through open-any dispatch answers '[object Object]x' — tag-5 string-lie boxing of the null externref in `__any_add` (task-82 de-vacuification)"
status: done
assignee: ttraenkler/fable-17th
sprint: 71
priority: medium
horizon: m
feasibility: medium
created: 2026-07-10
completed: 2026-07-10
task_type: bugfix
area: codegen
language_feature: any-boxing, addition, standalone
goal: standalone-mode
related: [1888, 2966, 3055, 2106, 3086, 2940, 3033]
loc-budget-allow:
  - src/codegen/any-helpers.ts
---

# #3135 — `__any_add` nullish-operand honesty (tag-5 string-lie family)

TaskList task #82 ("two pre-existing regressions from the recent merge window —
Iterator.zip/zipKeyed vacuous ×4 + issue-1888 NaN"), flagged by fable-3074 in
the #3033 issue file. Ground-checked on current `origin/main` (569e29b/32bae1f).
**Both flagged items turned out to be FAKE PASSES exposed by in-window HONESTY
changes, not new compiler regressions.** This issue fixes the one real
miscompile behind the issue-1888 half and documents the rest.

## Finding 1 — Iterator.zip/zipKeyed vacuous ×4: NOT a regression, already banked

`built-ins/Iterator/{zip,zipKeyed}/{basic-longest,basic-strict}.js` never
executed their assertions at ANY point: the `iteratorZipUtils.js` harness
include is neither inlined nor shimmed by `wrapTest` (tests/test262-runner.ts),
so `forEachSequenceCombination` / `assertZipped` / `assertIteratorResult` are
**undefined identifiers** in the wrapped source and the calls silently no-op.

- **Before the window** (aaa14719): the vacuity gate was
  `if (__harness_cb_expected > 0 && __assert_count === 1) return -262;` — zip
  tests never touch the (TypedArray-only) instrumented wrappers, so
  `__harness_cb_expected` stayed 0 and the tests returned 1 = **fake pass**.
- **In the window**: #3086 (PR #2792, honest-vacuity oracle) generalized the
  gate to an unconditional `if (__assert_count === 1) return -262;` — the four
  tests now honestly fail as `vacuous: harness-wrapper callback never executed
(#2940)`. Verified by running the wrapped test with each commit's own
  runner+compiler: aaa14719 → ret 1; current main → ret −262.
- The current baseline JSONL already records all four as `status: fail,
vacuous: true` — **the floor already absorbed the de-vacuification**; no
  scoreboard action needed.
- **Follow-up (backlog)**: add an `iteratorZipUtils.js` shim to `wrapTest` so
  the callbacks actually run (needs the shim + `Iterator.zip`/`zipKeyed`
  reachable from the injected `Iterator` binding). Honest-fail → honest-pass
  potential across the ~20 `built-ins/Iterator/zip*` files.

## Finding 2 — issue-1888 "propagates NaN": fake pass exposed by #3055; real bug fixed here

`tests/issue-1888-any-extern-roundtrip.test.ts` "propagates NaN (undefined
arg)" went red in the window. Bisect (repro: `o.two(undefined, 5)`; also the
direct-closure variant) → first bad commit `823fb685` (PR #2757, the **#3055
honest tag recovery for any-equality externref operands**). But #3055 is the
honesty fix, not the culprit:

- **Pre-#3055 the pass was FAKE.** At aaa14719 the dispatched add ALREADY
  corrupted: `r` was the string/number 5-ish wrong value, and the broken
  any-equality answered `r !== r` → true for every boxed operand pair (measured:
  even `r === r` was **false**, and `r === 5` was true while `r !== r` was also
  true). #3055's honest equality exposed the underlying miscompile.
- **The real miscompile:** `boxToAny`'s deliberate #1888 tag-5 default
  (`__any_box_string`) wraps the NULL externref — the standalone carrier of
  `undefined` crossing the open-any closure-dispatch boundary — as a tag-5
  "string" box with a null externval. `__any_add`'s #2966 stringy-operand test
  classified that box as stringy → CONCAT arm → `opToAnyString` stringified the
  nullish box like a plain object. Measured end-to-end:
  `String(o.two(undefined, 5)) === "[object Object]5"`, typeof → "object"-ish,
  `Number(r)` → NaN only via the unrecognized-box fallback.

### Fix (src/codegen/any-helpers.ts, consumer-side, #2966 style)

1. **`stringyOperand`**: a tag-5 box whose field-4 externval is NULL is a boxed
   nullish carrier, NOT a string (§13.15.3 — ToPrimitive(undefined/null) is
   never a String) → numeric arm. Genuine tag-5 strings always carry a
   non-null externval, so the guard is precise. Gating unchanged
   (`nativeBoxNumberTypeIdx >= 0`; legacy shape byte-identical).
2. **`__any_to_f64`** tag-5 arm: null externval → `f64.const NaN` (§7.1.4
   ToNumber(undefined) = NaN), matching the plane-wide undefined bias already
   chosen for the null externref (`__any_from_extern`'s nullAny is
   `{tag:1, f64val:NaN}`; standalone `typeof` answers "undefined").

Result: `o.two(undefined, 5)` → NaN, typeof number, `r !== r` true — the 1888
vitest test passes **honestly**. Controls unperturbed (2+3, floats, bools,
"a"+"b", "a"+5, 2/3/4-arg dispatch — all measured before/after).

## Remaining gaps (documented, NOT fixed here — #2106 S1 territory)

The null-vs-undefined COLLAPSE (one `ref.null extern` for both) is by
construction unfixable without the #2106 S1 $undefined-singleton sweep
(atomic producer+consumer flip; the partial attempt was parked PR #2025):

- **Direct closure call** `two(undefined, 5)` (no dispatch): the arg stays a
  BARE null externref into `__to_primitive`/`__unbox_number`, whose null arm
  reads 0 → answers 5. Pinned `it.fails` in tests/issue-3135.test.ts.
- **`u() + 1` where u returns undefined** (tests/issue-2966.test.ts's
  "undefined result + 1" guard): red on current main pre-existing — same bare
  null-externref seam. Converted to a documented `it.fails` pin.
- **Dispatch-returned strings misclassify under `typeof`**: `typeof
o.two("a","b") === "string"` answers false (value itself is correct "ab").
  Separate classification gap, not addressed here.

## Pre-existing red vitest tests found during ground-check (not mine, not fixed)

- `tests/issue-1888.test.ts` "unsupported built-in static value reads refuse
  loud" — fails on current main.
- `tests/issue-1888-s6c.test.ts` "guardrail: unsupported Builtin.method
  value-read still refuses-loud" — fails on current main.
  (Both are compile-time refuse-loud guardrails; some in-window change made the
  unsupported reads stop refusing. Worth a follow-up triage.)

## Test Results

- `tests/issue-3135.test.ts` (new): 9 passing + 2 honest `it.fails` pins.
- `tests/issue-1888-any-extern-roundtrip.test.ts`: 8/8 pass (was 7/8 — the
  NaN test is repaired honestly).
- `tests/issue-3055-numeric-any-eq-class.test.ts`: 9/9 pass.
- `tests/issue-2966.test.ts`: 15 pass + 1 documented `it.fails` (red on main
  before this PR).
- Seam-adjacent guards green: issue-1988, issue-2104-value-tags, issue-1211,
  issue-1910-s2, issue-3037-cs1c.
