---
id: 1315
title: "import.defer / import.source missing early error detection — 157 negative tests false-pass"
horizon: m
status: done
completed: 2026-07-17
created: 2026-05-07
updated: 2026-07-19
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: modules, import-defer, import-source
goal: spec-completeness
sprint: 72
---
# #1315 — `import.defer` / `import.source` early error detection gap (157 negative tests)

## Problem

157 tests with `negative: { phase: parse/early, type: SyntaxError }` are passing through the compiler and instantiating successfully. They should be rejected at parse/early-error time with `SyntaxError`.

Sample failing tests (all import.defer/import.source related):
```
test/language/expressions/dynamic-import/syntax/valid/nested-async-arrow-function-await-import-defer-assignment-expr-not-optional.js
test/language/expressions/dynamic-import/syntax/valid/nested-async-arrow-function-return-await-import-defer-no-rest-param.js
test/language/expressions/dynamic-import/catch/nested-async-gen-await-import-defer-specifier-tostring-abrupt-rejects.js
```

Additionally, 27 tests produce `Internal error compiling expression: Debug Failure. False expression: Trying to get the type of import.defer in import.defer(...)` — the compiler crashes instead of producing a clean unsupported-feature error.

## Root cause

Two gaps:

1. **Early error detection**: `import.defer(...)` and `import.source(...)` are Stage 3 proposals. In contexts where they are syntactically invalid (e.g. `await import.defer(...)` in certain positions), the compiler should raise a `SyntaxError` at parse/early-error time. Currently these constructs are not recognized and pass through without the required early error check.

2. **Compiler crash on `import.defer` type resolution**: TypeScript's checker throws `Debug Failure` when asked for the type of `import.defer(...)` — the compiler doesn't handle this node type and crashes with an internal error instead of a clean "unsupported feature" message.

## Fix approach

1. In `detectEarlyErrors()` (or equivalent early-error pass): recognize `import.defer` / `import.source` call expressions and emit `SyntaxError` in the restricted contexts per the Stage 3 spec.

2. In the codegen expression handler: add a case for `import.defer` / `import.source` AST nodes that emits a clean "unsupported feature: import.defer" compile error (matching the `unsupported_feature` pattern) rather than crashing with a Debug Failure.

## Acceptance criteria

- The 27 `Debug Failure` compile errors disappear — replaced by a clean "unsupported feature" error.
- The 157 negative-test false-passes flip to `pass` (compiler raises SyntaxError at the right phase).
- No regressions in module tests.

## Refreshed standalone evidence - 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The standalone root-cause classifier assigns **153** rows primarily to the
`import.defer` / `import.source` syntax and early-error family. This is
effectively the same size as the original 157 negative-test false-pass report,
but in the standalone artifact it is mixed with proposal syntax compile errors
and module-loader/runtime diagnostics. The root cause remains the same:
recognize the proposal forms in early-error detection and produce deliberate
syntax/unsupported-feature diagnostics instead of falling through into generic
codegen or runtime behavior.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).

## Resolution — verified already implemented (2026-07-17)

Re-validated against current `main` before implementing (per the #2148 note
above). **Both acceptance criteria are already met** — the fix landed in prior
work that referenced this issue, but the frontmatter was never flipped from
`ready`. Evidence:

- **Early-error / SyntaxError detection** lives in
  `src/compiler/early-errors/node-checks.ts` — the `ts.isMetaProperty` check
  (`import.defer` / `import.source` → `SyntaxError`) at ~L1285-1295 plus the
  arg-count checks at ~L1613/1641. It walks the whole AST including unreferenced
  bodies, so it fires on the dead-code negative-test shapes. The in-code comment
  notes "The earlier call-only check (#1315) is subsumed by this."
- **Debug-Failure crash guard**: `src/codegen/expressions/calls.ts:5494-5509`
  emits a clean unsupported-feature `SyntaxError` for the meta-property callee,
  and `src/codegen/expressions.ts:1275` skips the async-call
  `getResolvedSignature` query that used to re-trigger the TS
  `Debug Failure: Trying to get the type of import.defer` assertion.
- **Regression test present and green**: `tests/issue-1315.test.ts` — 9 tests,
  all passing (verified 2026-07-17), covering the no-crash path, dead-code
  early-error detection, and non-regression of `import()` / `import.meta`.
- **test262 negative corpus**: all **168** `invalid/` `import-defer` /
  `import-source` syntax tests under
  `language/expressions/dynamic-import/syntax/invalid/` are now correctly
  rejected at compile time (0 false-passes, 0 `Debug Failure` crashes),
  measured directly against current `main`. Acceptance criterion 1 (27 crashes
  gone) and criterion 2 (157 negative false-passes flip) are satisfied.
- The `valid/` proposal tests remain **skipped** by the runner —
  `import-defer` and `source-phase-imports` are in the SKIP feature list
  (`tests/test262-runner.ts:171-172`), because implementing the Stage 3
  proposals themselves is explicitly out of scope here (tracked separately by
  #1615 "source-phase-imports / import-defer proposal deferred").

No code change required. This PR only flips `status: ready → done` and records
the verification. Closing as **done**.
