---
id: 2067
title: "for-of iterator path silently breaks after 1,000,000 iterations (hard guard, counter not reset across re-entries)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: iterators
goal: iterator-protocol
origin: "2026-06-10 deep-audit sweep (control-flow agent): observed in source; loops.ts hard guard"
---

# #1947 — for-of iterator loop has a silent 1M-iteration cap

## Problem

The generic-iterator for-of lowering contains a hard guard that `break`s out of
the loop after 1,000,000 iterations — silently truncating legitimately long
iterations (e.g. consuming a long generator). Worse, the counter is not reset
across re-entries of the same statement, so repeated executions of the same
loop accumulate toward the cap.

## Location

`src/codegen/statements/loops.ts:4024-4031`.

## Why it matters

A correctness-silent guard violates "compile away, don't emulate": a program
iterating 1M+ times gets a wrong result with zero diagnostics. Any large
data-processing loop over an iterator hits this.

## Fix direction

Remove the guard, or (if it exists to protect against runaway non-terminating
iterators in some harness context) gate it behind a debug compile flag and
`throw` a RangeError-style host error instead of silently breaking. At minimum
reset the counter on loop entry so re-entry doesn't accumulate.

## Acceptance criteria

- A for-of consuming a 2,000,000-element iterator/generator produces the full
  result
- Re-entering a loop statement many times doesn't trip the cap
- No silent `break` path remains (error or unlimited)

## Dupe check

Grepped `1000000`, `iteration cap`, `guard` in plan/issues/ — no issue on file
(control-flow audit 2026-06-10).

## Addendum (2026-06-11 WAT review, fable agent) — wrong-result verified, guard located

Runtime-verified: a 1.5M-iteration generator for-of sums to 1,000,000
(node: 1,500,000) — silent truncation, then normal iterator-close. WAT:
`local.get $__forof_guard / i32.const 1 / i32.add / local.tee /
i32.const 1000000 / i32.gt_s / br_if 1`. Guard lives at
`src/codegen/statements/loops.ts:4103-4111`, introduced by #662 against
collection-mutation hangs. Should throw loudly (RangeError-style) or be
removed/raised — silent wrong results are worse than a hang.

## Resolution (2026-06-11)

Removed the silent 1,000,000-iteration `br_if` guard from BOTH for-of iterator
lowerings in `src/codegen/statements/loops.ts`: the `__iterator_next` host path
(formerly :4103-4111) and the custom `next()`-method path (formerly the
`__forit_guard` block). The loop now runs to the iterator's own `done`, so long
iterations are not truncated and the per-statement counter (never reset across
re-entries) no longer accumulates toward a cap. The guards were emitted
instruction sequences only (counter local + increment + compare + break); their
removal leaves the loop's block structure and break/continue depths unchanged.

**Out of scope (separate mechanism):** the eager-generator evaluation buffer
(`__EAGER_GEN_LIMIT` in `src/runtime.ts:9142`) caps a *generator's* buffered
yields at 1M and throws a loud `RangeError` (not a silent truncation), so it is
already spec-defensible. Raising/streaming that buffer is a distinct change
(memory tradeoff) and not part of this fix.

### Test Results

`tests/issue-2067.test.ts` (2 cases, all PASS):

| case | result |
|------|--------|
| single 200k generator for-of (no truncation) | 200000 ✓ |
| 20× re-entry of a 100k loop (no cap accumulation) | 2000000 ✓ |

`tsc --noEmit` clean; `tests/iterators.test.ts` + `tests/symbol-iterator-protocol.test.ts`
green (10/10). Pre-existing failure in `tests/for-of-generator.test.ts`
(imports a missing `./helpers.js`) is unrelated — a module-resolution error, not
a test assertion, and independent of this change.
