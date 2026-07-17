---
id: 3370
title: "Test262 project runner: make the original harness the verdict oracle"
status: ready
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: test262-runner
goal: test262-conformance
assignee: codex/root
related: [3362, 3369]
files:
  - .github/workflows/ci.yml
  - tests/test262-original-harness.ts
  - tests/test262-runner.ts
  - tests/test262-shared.ts
  - scripts/test262-worker.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-reader.mjs
  - tests/test262-oracle-version.ts
  - tests/issue-3370.test.ts
---
# #3370 — make the original Test262 harness the project-runner oracle

## Problem

The synthetic `wrapTest()` runner reported 50/50 passes for the deterministic
array sample while test262.fyi's literal upstream harness reported only 25/50.
The wrapper silently changed observable semantics:

- `stripUndefinedThrowGuards()` removed sparse-hole failure checks;
- moving raw script code inside `export function test()` converted top-level
  module-global state into locals, bypassing global representation failures;
- synthetic `assert.throws` and `Test262Error` shims replaced the upstream
  harness's real exception and constructor-identity behavior.

As a result, the project's pass count could describe successful execution of a
rewritten surrogate rather than the upstream test.

## Acceptance criteria

- Assemble project-runner inputs from the runtime shim, upstream harness
  includes, `assert.js`, `sta.js`, and the unmodified test body.
- Do not use `wrapTest()` transformations to decide Test262 pass/fail status.
- Preserve Test262 strict reruns and negative/async verdict semantics.
- Make the canonical local/CI runner and `runTest262File()` use the same literal
  harness contract.
- Add a regression proving a deliberately failing undefined guard cannot be
  erased into a pass.
- The deterministic first 50 array records have identical statuses in the
  project runner and test262.fyi original-harness lane.
- Bump the Test262 oracle version for the intentional honesty reclassification.

## Resolution

- Added one literal-harness assembler shared by `runTest262File()` and the
  sharded CI runner. It preserves upstream source text and Test262's sloppy +
  strict execution variants.
- Kept `wrapTest()` only as the explicitly named
  `runSyntheticTest262File()` diagnostic lane; it no longer contributes
  conformance verdicts.
- Made successful top-level module initialization the positive verdict, with
  async completion/failure markers and phase/type-correct negative handling.
- Tightened both the project and test262.fyi lanes so wrong-phase negative
  failures cannot count as passes.
- Bumped the Test262 oracle from v7 to v8. Landing requires an
  `ORACLE_REBASE=1` baseline refresh.

## Validation

- `pnpm run typecheck`
- `pnpm exec vitest run tests/issue-3370.test.ts tests/test262-fyi-runner.test.ts --reporter=dot`
  — 10/10 passed.
- Deliberately failing undefined guards are failures in both the in-process
  runner and unified CI worker.
- Wrong-phase negative probes fail in both verdict paths.
- `node scripts/run-test262-fyi.mjs --filter language/expressions/array --limit 50`
  — original harness 50/50.
- Unified CI worker on the identical sorted 50-test sample, including strict
  reruns — 50/50.
