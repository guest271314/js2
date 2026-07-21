---
id: 3109
title: "Test-helper consolidation: 132 test files re-declare compileAndRun (10+ signature variants) across 292k test LOC"
status: ready
sprint: current
assignee: ttraenkler/dev-serve
created: 2026-07-09
updated: 2026-07-22
priority: high
# 2026-07-12 (#3182 groom): elevated Backlog/medium → current/high.
# Re-measured: 133 test files declare their own compileAndRun today.
horizon: m
feasibility: easy
model: opus
reasoning_effort: medium
task_type: refactor
area: tests
language_feature: compiler-internals
goal: maintainability
related: [3102]
---

# #3109 — Consolidate duplicated test harness helpers

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`tests/` is 1,923 files / **292,655 LOC** — comparable to src/ itself — with
no shared compile-and-run harness:

- **132 test files define their own local `compileAndRun`**, in at least 10
  divergent signatures (`(source: string)` ×34, `: Promise<Record<string,
Function>>` ×13, `: Promise<any>` ×11, `: Promise<number>` ×9, result-object
  variants ×6, …).
- **793 test files** hand-roll the `compile(...)` → `buildImports`/
  `instantiateWasm` → export-call sequence inline.
- `tests/helpers/` exists but contains only `ir-fallbacks.ts` (19 LOC).

Each local copy re-implements the same 10–30 lines (compile, instantiate,
maybe setExports wiring for host closures — a known trap, see memory
`project_wrapforhost_setexports_harness`), and behavioral drift between
copies means two tests can disagree on what "run" means (e.g. whether
`callbackState.getExports` is wired), which produces confusing
false-negative repros.

## Fix

1. Add `tests/helpers/compile.ts` with the ~4 canonical shapes:

```ts
export async function compileAndInstantiate(src: string, opts?: CompileOpts): Promise<WebAssembly.Exports>;
export async function compileAndRun(src: string, entry = "main", opts?: CompileOpts): Promise<unknown>;
export async function compileAndRunStandalone(src: string, entry?: string): Promise<unknown>;
export async function compileExpectError(src: string): Promise<{ errors: string[] }>;
```

— implemented ONCE on top of `src/runtime.ts` `instantiateWasm`, with the
setExports/callbackState wiring done correctly by default. 2. Migrate mechanically, in batches of ~20 files per commit: delete the local
helper, import the shared one. **Only migrate files whose local copy is
semantically equivalent to a canonical shape** — a file whose helper does
something extra (custom import stubs, wasi polyfill knobs) keeps its local
helper (or passes the extra via `opts`). 3. New-test guidance: one line in `tests/README` (or CLAUDE.md tests section)
pointing at the helper.

## Safety story

Zero compiler-source changes — emitted Wasm untouched by construction. The
risk is _test semantics drift_ during migration; guard: each batch must keep
every migrated test green with **unchanged assertions** (vitest run scoped to
the batch). A test that fails after migration reveals its local helper was
NOT equivalent → revert that file from the batch and leave it local.

## Estimated LOC delta

≈ **−2,000 to −3,500** in tests/ (15–25 lines × 132 files, plus partial
adoption by the 793 inline sites in new/touched tests). More valuable:
one correct harness for host-closure wiring.

## Acceptance criteria

1. `tests/helpers/compile.ts` exists; ≥ 100 of the 132 local definitions removed.
2. Full vitest suite green with unchanged assertions.
3. No src/ changes in the PR(s).

## Progress

### Slice 1 (ttraenkler/opus-tests) — 19 files, `tests/helpers/compile.ts` seeded

Behavior-preserving refactor. `tests/helpers/compile.ts` created with the three
highest-duplication **identical-body** clusters extracted ONCE. Migrated files
delete their local `compileAndRun` and import the shared function under an alias
(`import { compileAndRunStubs as compileAndRun } from "./helpers/compile.js"`),
so every call site is unchanged.

Why three distinct helpers, not one merged shape: the clusters differ in how
they wire host imports, and merging them would change which imports a module
links (semantic drift). Each exported function is byte-for-byte behaviorally
identical to the local copy it replaces:

- `compileAndRunStubs` — 9 files: assert `result.success` (msg + WAT), bare
  `env.console_log_*` no-op stub imports. codegen, void-expr, compiler, bitwise,
  generics, numeric-separators, logical-assignment, issue-243, spread-rest.
- `compileAndRunImportObject` — 5 files: assert `result.success` (no WAT),
  instantiate against `result.importObject!`. issue-2055/2062/2067/2053/2065.
- `compileAndRunBuildImports` — 5 files: guard non-empty `result.binary` then
  full `buildImports(...)` host object; compiles with `{ fileName: "test.ts" }`.
  math-minmax, issue-146, math-inline, new-array, string-coercion.

Net −247 LOC across the 19 test files; +78 for the shared module. Orphaned
`compile` / `buildImports` imports dropped where the local helper was their only
user.

**Parity proof:** the 19 files were run with `vitest --reporter=json` before and
after migration — identical per-test result set (224 tests, 125 pass / 99 fail;
the 99 pre-existing main-state failures are unchanged). Full `tsc --noEmit`,
`biome lint`, and `prettier --check` all green. Zero `src/` changes.

**Remaining (future slices):** ~113 local `compileAndRun` definitions across the
other signature variants (result-object shapes, `Promise<number>`,
`expectCompiles`-based, custom import-stub variants, `compileAndRunMulti`, …).
Migrate additional identical-body clusters the same way; keep non-equivalent
local helpers local (or thread the extra via an `opts` param). This issue stays
`ready` until ≥100 of 132 removed (acceptance criterion 1).

### Slice 2 (ttraenkler/fable-interp, 2026-07-16) — 39 files, 14 clusters

Same identical-body-cluster method, applied to every remaining exact-duplicate
cluster (body-hash grouping over the `async function compileAndRun` block):
13 new helpers in `tests/helpers/compile.ts` (`compileAndRunHost` ×7,
`compileAndRunInstance` ×5, `compileAndRunTestSync` ×4,
`compileAndRunResultObject` ×5 — the `.test?.()` pair threads
`optionalTest: true` via a one-line local wrapper — plus nine 2-file shapes:
TestSyncSetExports, RuntimeDeps, BuildImportsExpect, StubsCallback,
TestSyncNumber, TestSyncJoined, GetResult, Fn, TestNumber).

**Parity proof:** the 39 files ran with `vitest --reporter=json` before and
after — identical per-test result set (287 tests, 258 pass / 29 pre-existing
main-state fails). One non-equivalence the hash clustering missed was CAUGHT
by exactly this gate and fixed: issue-1594b/issue-723-tdz's local
`buildImports(wasmModule)` is a **reflected no-op stub synthesizer**, not
src/runtime's `buildImports` — moved verbatim into the helper as the private
`reflectedStubImports` (all 12 tests re-verified green). Scoped tsc + prettier
clean. Zero `src/` changes.

**Count:** 132 → 19 (slice 1) → 39 (this slice) removed; **~67 local
definitions remain** (all singleton bodies by exact hash — next slice needs
normalized/semantic clustering or opts-threading).

### Slice 3 (ttraenkler/dev-serve, 2026-07-22) — 10 files, 3 helpers

Same identical-body method, applied to the remaining **code-identical (modulo
comments/whitespace)** clusters found by comment-stripped body-hash grouping over
the 90 files that still declared a local `compileAndRun`:

- `compileAndRunIRVariant(source, fnName, args, experimentalIR)` — the 6
  `tests/equivalence/ir-slice*` IR-vs-legacy files (`ir-slice10-{map-set,
  extern-regexp,error,typed-array,date}` + `ir-slice4-classes`). All 6 had a
  byte-identical local `compileAndRun` **and** a byte-identical local `ENV_STUB`
  (bare no-op `console_log_*` stubs); the helper embeds the stub inline.
- `compileAndRunHoistExports(source)` — issue-298 + var-hoisting (2 files):
  guard on non-empty `result.binary` (NOT `result.success` — var-hoisting trips
  a benign TS "used before assigned" diagnostic), `buildImports` host object,
  return exports.
- `compileAndRunVecSetExports(source)` — issue-1441 + issue-1057 (2 files):
  sync `new Module`/`Instance` + `setExports` wiring for the `__vec_len`
  `constructor === Array` lookup, return `test()`.

Each migrated file deletes its local helper (+ orphaned `compile`/`buildImports`
imports + `ENV_STUB`) and imports the shared function under the
`{ X as compileAndRun }` alias, so every call site is unchanged.

**Parity proof:** the 10 files ran green post-migration — `vitest run` = 10
files / **52 tests, all pass**. The migration is byte-for-byte behavior-
preserving (bodies verified identical modulo comments before migration), so no
pass→fail drift is possible. Scoped `tsc --noEmit`, `biome lint`, and
`prettier --check` all clean. Zero `src/` changes.

**Count:** 132 → 19 → 39 → **52 removed**; **80 local definitions remain**
(the residual is genuine singleton/near-singleton bodies — the string-normalized
clustering finds only ~4 more 2-file groups whose bodies differ in error-message
code, needing opts-threading or per-file equivalence review to migrate safely).
Issue stays `ready` until ≥100 of 132 removed (acceptance criterion 1).
