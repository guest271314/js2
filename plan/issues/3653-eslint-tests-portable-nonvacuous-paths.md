---
id: 3653
title: "ESLint integration tests: portable dependency paths and non-vacuous skip semantics"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: test
area: test-infrastructure
language_feature: npm-package-integration
goal: npm-library-support
sprint: 76
required_by: [1400]
es_edition: n/a
related: [1282, 1400, 1573, 2693]
---
# #3653 — Make the ESLint integration ladder portable and non-vacuous

## Problem

The ESLint tests encode Linux-container paths rather than resolving the
installed package from the repository:

- `tests/stress/eslint-tier1.test.ts` uses
  `/workspace/node_modules/eslint/...`;
- `tests/issue-2688.test.ts`, `tests/issue-2689.test.ts`,
  `tests/issue-1289.test.ts`, and
  `tests/issue-2693-host-delegated-select.test.ts` do the same;
- `tests/issue-1557.test.ts` uses `/home/user/js2wasm/...`.

The most serious case is
`tests/issue-2693-host-delegated-select.test.ts`: a `try/catch` around
`realpathSync("/workspace/...")` returns from the test when the path is absent.
Vitest therefore reports a pass without loading real `espree`/`esquery`,
compiling the Wasm Linter, or running any assertion.

## Measured evidence (2026-07-26)

On macOS, the stock dual-host-delegation test reported PASS in 1 ms because it
returned before the compiler call. Replacing only the absolute path with the
repository-relative installed ESLint path made the test execute and exposed a
real compile blocker:

```text
Codegen error: IR path failed for Linter_verify:
ir/from-ast: call to unknown function "__host_is_statement"
in Linter_verify [IR-FALLBACK]
```

That compiler blocker is tracked separately by #3657. The path fix must not
hide it.

## Required change

1. Add one shared test helper that resolves ESLint from the test file/repository
   (`createRequire`, `require.resolve("eslint")`, and `realpathSync` as needed).
   Do not assume `/workspace`, `/home/user`, or a particular pnpm store path.
2. Replace every hard-coded ESLint path in the tests listed above.
3. When the optional fixture is genuinely unavailable, use an explicit Vitest
   skip mechanism with a visible reason. Never treat `catch { return; }` as a
   pass.
4. For the dual-delegation test, assert that real `espree` and `esquery` were
   loaded before compiling the Linter.
5. Include compiler diagnostics in failed compile assertions.
6. Make the first end-to-end ESLint test a **JS-host-lane** test running under
   Node. Node builtin imports (`node:*` and their unprefixed equivalents) are
   host dependencies for this rung: wire them to the real Node modules instead
   of requiring standalone/WASI implementations or compiler-side polyfills.

## Acceptance criteria

- The ESLint integration tests execute the same real package files on macOS and
  Linux.
- No ESLint test contains `/workspace/node_modules/eslint` or
  `/home/user/js2wasm/node_modules/eslint`.
- An unavailable dependency is reported as skipped, not passed.
- The dual-delegation test fails on #3657 until that compiler issue is fixed;
  it cannot return early and appear green.
- `tests/stress/eslint-tier1.test.ts` reports the actual compile/validate/run
  frontier without path-related false failures.
- Its first runnable `Linter.verify()` proof uses the default JS-host target,
  instantiates in Node, and demonstrates that required Node builtins are passed
  through to that host. Standalone ESLint is explicitly not this first gate.
