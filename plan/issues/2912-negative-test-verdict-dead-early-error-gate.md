---
id: 2912
title: "test262 runner marks negative parse/early tests pass on ANY compile error (dead `? \"pass\" : \"pass\"` gate)"
status: ready
priority: medium
sprint: current
created: 2026-07-01
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
