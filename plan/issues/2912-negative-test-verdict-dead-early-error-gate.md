---
id: 2912
title: "test262 runner marks negative parse/early tests pass on ANY compile error (dead `? \"pass\" : \"pass\"` gate)"
status: done
assignee: ttraenkler/fix2912
priority: medium
sprint: 69
created: 2026-07-01
completed: 2026-07-01
feasibility: medium
task_type: bug
area: tooling
goal: developer-experience
related: [2911, 2898]
---

# #2912 — Negative parse/early tests pass on ANY compile error; the error-code gate is dead code

Found during the #2911 test262-setup audit.

## Problem

For a negative test with `phase: parse | early | resolution`, the runner is
supposed to count it as a conformance pass only when the compiler rejected the
program for the *right* reason. The code computes `hasEarlyError` from an
`ES_EARLY_ERRORS` code set — then throws the result away with a ternary whose
two arms are identical:

- **`scripts/test262-worker.mjs:1146-1155`** (the authoritative CI worker):
  ```js
  if (execute && isNegative) {
    const ES_EARLY_ERRORS = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);
    const hasEarlyError = errorCodes.some((c) => ES_EARLY_ERRORS.has(c));
    sendResult({ id, status: hasEarlyError ? "pass" : "pass", ... });  // both arms "pass"
  }
  ```
- **`tests/test262-vitest.test.ts:616-626`** (secondary two-phase runner) has the
  same shape:
  ```js
  if (hasEarlyError) { recordResult(..., "pass", ...); }
  else               { recordResult(..., "pass", ...); }   // both "pass"
  ```

Net effect: a `phase:parse|early|resolution` test is recorded **pass whenever
the compiler emits any compile error**, regardless of the error code or type.
`ES_EARLY_ERRORS` + `hasEarlyError` are dead code that *look* like a gate.

## Why it's a defect

- **Inflates the negative-test pass count.** A negative test that our compiler
  rejects for an *unrelated* reason (an unsupported-syntax CE, a codegen bug, a
  TS parse error on a different construct) is scored as a conformance pass — we
  never verify the rejection is the spec-mandated `SyntaxError`/`type`.
- **No error-type verification at all.** test262 negative metadata carries the
  exact `type` (e.g. `SyntaxError`); the runner ignores it.
- **Interacts with the warning→pass fragility (#2898).** #2898's resolution
  notes a negative test that "only 'passed' incidentally via the runner's
  warning→pass heuristic" — the verdict gate at `test262-worker.mjs:1103` blocks
  only on `severity === "error"`, so a compile that emits *warnings* (e.g. the
  IR-fallback demotion at `src/codegen/index.ts:1054`, `severity: hard ? "error"
  : "warning"`) sails through to execution/instantiation and can be scored pass.

Applies identically to host (`gc`) and standalone targets, so it does **not**
break host↔standalone comparability, but it makes **both** lanes optimistic on
the negative-parse/early population.

## Fix direction

- Make the ternary a real gate: pass only when `hasEarlyError` (an ES early-error
  code was raised) OR the compile error's reported type matches the test's
  `negative.type`. Otherwise record `compile_error`/`fail`, not `pass`.
- Consider verifying `negative.type` for the instantiate-fails arm too
  (`test262-worker.mjs:1220-1236`).
- **Judgment call for the PO:** tightening this will *lower* the reported pass
  count (some current "passes" flip to fail) while making the number honest.
  Decide whether to (a) land the gate + re-baseline, or (b) keep the lenient
  "rejected-for-any-reason = pass" policy but *delete the dead `ES_EARLY_ERRORS`
  code* and document the policy so it stops masquerading as a strict gate.

## Acceptance
- No dead `? "pass" : "pass"` gate; negative-test verdict is either a real
  error-type/early-error gate or an explicitly-documented lenient policy.
- Behaviour identical across `gc` and `standalone` targets.

## Resolution (2026-07-01)

### Quantification first (per the re-baseline-handling requirement)

Recompiled **every** currently-passing negative `parse|early|resolution` test
(host baseline pass-set: **4,549** tests) and classified how the compiler
rejected each. Full-corpus scan also confirms the population is **100%
`type: SyntaxError`** (4,595 parse + 34 resolution; **zero** non-SyntaxError
parse/early/resolution negatives exist in test262).

Two arms:

| arm | count | what happens | tightened-gate flip |
| --- | --- | --- | --- |
| **compile-FAILED** (raised a compile error) | 4,110 | all are genuine static/syntax rejections (`';' expected`, `Invalid LHS`, `Rest element…`, `super() only valid…`, duplicate-decl, strict-mode, numeric-separator 6188/6189, `for-in requires…`, exponentiation-LHS, hashbang, …) | **0** |
| **compile-SUCCEEDED** (no error raised) | 439 | pass ONLY incidentally — the produced Wasm fails to instantiate/link (`await`/`yield` as binding identifier, escaped keywords, duplicate module exports, unresolved imports = real early-error-detection gaps; the #2898 fragility) | **439** |

A naive code-range classifier (TS 1xxx only) *looked* like it flipped 82, but
inspection showed all 82 are **genuine** syntax detections our classifier merely
failed to recognize (6xxx numeric-separator codes, no-code syntactic messages) —
flipping them would be **false regressions**, not a correctness gain. So the
compile-FAILED arm has ~0 true false-passes.

### What landed (0 verdict change → passes the regression gate)

A shared `scripts/negative-verdict.mjs` (`negativeCompileErrorMatches`) used by
**both** runners (`scripts/test262-worker.mjs` + `tests/test262-vitest.test.ts`),
replacing the dead `? "pass" : "pass"` with a **real, `negative.type`-aware
gate** on the compile-FAILED arm:
- SyntaxError (the whole current population): any raised compile error is a
  static rejection ⇒ pass (verified 0/4,110 flips).
- non-SyntaxError (currently empty, future-proof): requires the diagnostic to
  evidence the expected type; a wrong-reason rejection now records
  `compile_error`, not `pass`.
- unknown/absent expected type: stays lenient (never a false regression).

Identical logic across `gc`/`standalone` (single shared module). Unit test:
`tests/issue-2912.test.ts`. `tsc --noEmit` clean; prettier clean.

The compile-SUCCEEDED/instantiate-throw arm is kept as an **explicitly-documented
lenient fallback** (loud comments in both runners referencing this issue) — it
does not masquerade as a strict gate. This satisfies the Acceptance ("a real
error-type/early-error gate ... or an explicitly-documented lenient policy").

### Stopped-at-report (needs coordinated re-baseline — PO/lead call)

Strictly gating the compile-SUCCEEDED arm (require a compile-time diagnostic of
the expected type instead of an incidental Wasm-instantiate failure) is the real
numeric tightening: **it flips ~439 host-lane negatives pass→fail.** This is a
genuine correctness improvement (we currently score a pass for SyntaxError tests
we compile without detecting the error), but it **cannot land in this PR**:
- `scripts/test262-worker.mjs` is on the `test262-sharded.yml` path filter, so
  the change re-runs full test262; a 439-drop trips the `check for test262
  regressions` / merge-group `auto-park` gates.
- There is **no in-PR intentional-drop flag**. The baseline (`loopdive/js2wasm-baselines`)
  only advances **post-merge** via `promote-baseline`; the only override is the
  maintainer `workflow_dispatch` `force_promote=YES` on `test262-sharded.yml`.

**Re-baseline strategy (split):** land this verdict-logic fix (done), then a
**follow-up PR** that (a) switches the compile-SUCCEEDED arm to strict in both
runners, and (b) is merged with a coordinated baseline bump — either the
maintainer `force_promote` dispatch, or landing the runner change behind a merge
that the PO/lead approves as an intentional −439 drop, so `promote-baseline`
re-seeds the floor to the honest number. The ~439-file list is captured in the
audit (categories: `language/expressions` 133, `module-code` 128,
`statements` 117, plus asi/punctuators/keywords/literals).
