---
id: 700
title: "Reuse TypeScript Program and checker state across incremental builds"
status: in-review
created: 2026-03-20
updated: 2026-07-26
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: checker, compiler
goal: performance
sprint: current
files:
  - src/checker/language-service.ts
  - src/index.ts
  - tests/issue-1119.test.ts
  - tests/issue-973-repro.test.ts
  - tests/issue-973.test.ts
  - tests/issue-incremental.test.ts
  - tests/typescript-diagnostic-failures.test.ts
---

# #700 — Reuse TypeScript Program and checker state across incremental builds

## Status: in review

Implemented in [PR #3645](https://github.com/loopdive/js2/pull/3645).

The original issue proposed an explicit `reuseHost` option on
`compile()`/`compileSource()`. It was closed as superseded after
`createIncrementalCompiler()` and persistent compiler-pool workers landed.
Subsequent profiling showed that the underlying optimization was not actually
complete: the incremental path cached parsed library files but still created a
fresh TypeScript `Program` and `TypeChecker` for every build.

## Problem

The TypeScript frontend dominates compilation time for small and medium inputs:

| Input           | TypeScript parse + check | Total compilation | Frontend share |
| --------------- | -----------------------: | ----------------: | -------------: |
| Fibonacci       |                 185.3 ms |          193.4 ms |          95.8% |
| Built-ins-heavy |                 195.8 ms |          276.0 ms |          70.9% |

Caching only immutable library `SourceFile` objects reduced some repeated
parsing, but each call still rebuilt the user-source Program, checker, symbols,
and diagnostics. This limited the old incremental wrapper to roughly a 4–7%
improvement.

## Implementation

PR #3645 replaces per-build `ts.createProgram` construction with a persistent,
versioned TypeScript Language Service:

1. A versioned `SourceSnapshot` computes the exact common-prefix/common-suffix
   `TextChangeRange`, allowing TypeScript to incrementally update the mutable
   source AST.
2. An unchanged source keeps the same Program, checker, source file, and
   diagnostic caches.
3. Source text, filename, and ScriptKind changes increment the document and
   project versions.
4. Compiler-option and ambient-library changes recreate the Language Service
   because TypeScript does not include the host-selected default library name
   in its project-structure reuse key.
5. A shared `DocumentRegistry` and immutable library snapshots avoid duplicating
   the large standard-library ASTs between compiler instances.
6. Mutable user-document versions include a per-service namespace, preventing
   two compiler instances using the same virtual filename from aliasing
   different source text.
7. JavaScript, JSX, TypeScript, and TSX inputs retain their correct ScriptKind
   and `allowJs`/JSX compiler settings.

## Performance evidence

Median local measurements after warm-up:

| Input           |                  Edited rebuild |              Unchanged rebuild |
| --------------- | ------------------------------: | -----------------------------: |
| Fibonacci       |  208.2 ms → 79.0 ms (**2.64×**) | 208.2 ms → 33.4 ms (**6.24×**) |
| Built-ins-heavy | 250.3 ms → 114.4 ms (**2.19×**) | 250.3 ms → 61.4 ms (**4.08×**) |

Edited builds still run the existing IR and code-generation pipeline. Unchanged
builds obtain the larger gain because the full TypeScript frontend result can
be reused.

## Correctness and isolation

The implementation adds or strengthens coverage for:

- unchanged Program/checker/source-file identity
- source-edit invalidation and stale-diagnostic removal
- browser-to-Node ambient-library invalidation
- filename and ScriptKind changes
- simultaneous compiler instances with the same virtual filename
- JavaScript-mode byte parity with standalone compilation
- byte-for-byte isolation across 100 unrelated sequential sources
- hard TypeScript diagnostics on the asynchronous incremental API

Existing incremental tests were also corrected to await `compiler.compile()`;
several had previously asserted properties on unresolved Promises.

## Approaches rejected

- **Raw `oldProgram` hand-off:** previously caused stale checker state and
  cross-compilation poisoning in long-lived worker pools. Language Service
  versioning owns invalidation instead.
- **One DocumentRegistry per compiler:** correct but duplicated the large
  standard-library AST in every compiler instance and exhausted the default
  worker heap under broad suites. A shared registry plus service-scoped mutable
  document versions preserves isolation without that memory cost.
- **Standalone `vitest run` as the test262 gate:** invalid for this repository
  because test262 requires its Phase-1 precompile cache. The direct invocation
  produced cache misses rather than meaningful compiler failures.

## Validation

- `pnpm exec tsc --noEmit --pretty false`
- focused Biome lint over all seven changed files
- focused Vitest suite: 5 files, 23 tests passed
- repository pre-push typecheck, lint, formatting, and committed-issue integrity
  gates

## Files changed

- `src/checker/language-service.ts`
- `src/index.ts`
- `tests/issue-1119.test.ts`
- `tests/issue-973-repro.test.ts`
- `tests/issue-973.test.ts`
- `tests/issue-incremental.test.ts`
- `tests/typescript-diagnostic-failures.test.ts`

## Resolution

Merge PR #3645, then transition this issue from `in-review` to `done`.
