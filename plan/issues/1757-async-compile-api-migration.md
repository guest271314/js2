---
id: 1757
title: "Migrate the public compile() API to async (embed binaryen via await import)"
status: done
created: 2026-05-31
updated: 2026-05-31
completed: 2026-05-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler-api
goal: platform
sprint: Backlog
related: [1756, 986]
---
# #1757 — Migrate the public `compile()` API to async

## Why

Follow-up to **#1756** (GH #986). #1756 unblocked the bundler build via a
`createRequire` shim, but the optional `binaryen` optimizer is still loaded with
a synchronous require, so a standalone `bun --compile` / `deno compile` binary
**cannot embed binaryen** (it resolves at runtime / skips gracefully). The clean
end-state is `await import("binaryen")`, which requires the compile pipeline to
be **async**. User-directed (2026-05-31) to do the full migration.

## Scope / blast radius (measured)

- `compileSource` is fully synchronous codegen; the **only** async-needing step
  is binaryen's wasm-opt. The async loader already exists: `optimizeBinaryAsync`
  + `getBinaryenModule` (`await import("binaryen")`).
- **Public sync entry points** to convert: `src/index.ts:261 compile()`,
  `src/compiler.ts:136 compileSource`, `:551 compileMultiSource`,
  `:826 compileFilesSource`.
- **In-src callers** (~9): `index.ts` wrappers (262/312/333/338/386/412),
  `runtime-instantiate.ts:81`, `runtime.ts:9637` (both already inside async
  `compileAndInstantiate`), `cli.ts:191` (CLI is already async — `await import`).
- **Test ripple: ~1,675 `compile(...)` call sites across 761 files.** This is the
  bulk of the work and is mechanical (codemod).

## Implementation plan (staged — run the suite LOCALLY after the codemod, then CI gates)

**Phase 1 — source (reviewable, small):**
1. `compiler.ts`: make `compileSource`/`compileMultiSource`/`compileFilesSource`
   `async` → `Promise<CompileResult>`; replace the 3 internal `optimizeBinary(...)`
   calls (491/772/1012) with `await optimizeBinaryAsync(...)`.
2. `index.ts`: make `compile()` + the multi/files/wat wrappers `async`, `await`
   their inner `compile*Source` calls (262/312/333/338/386/412/412-service).
3. `runtime-instantiate.ts:81` + `runtime.ts:9637`: `await compileSource(...)`
   (already in async fns).
4. `cli.ts:191`: `const result = await compile(...)` (already top-level-await).
5. Keep the **sync** `optimizeBinary` + its `createRequire` shim for any
   remaining sync internal use, OR delete it if no longer referenced.

**Phase 2 — test codemod (~1,675 sites / 761 files):**
- Script: for each `tests/**/*.test.ts`, wrap `compile(` → `await compile(`
  (NOT `compileAndInstantiate`/`compileToWat`/`compileSource` unless converted),
  and ensure the enclosing `it(...)/test(...)/beforeEach(...)` callback is `async`.
- Prefer an AST codemod (ts-morph / jscodeshift) over regex to avoid mangling
  `it.each`, nested arrows, and already-async callbacks. Validate the codemod on
  a few files first, then run repo-wide.
- Update any other consumers: `playground/`, `scripts/runner-bundle.mjs`
  (regenerate), docs snippets.

**Phase 3 — embed binaryen in standalone:**
- Point the CLI/standalone build at the async path so `await import("binaryen")`
  is bundled. Verify `bun build --compile` / `deno compile` embed binaryen and
  the resulting single-file binary optimizes without binaryen on PATH.

## Acceptance

- `compile()` and the `compile*Source` entry points are async; CI green
  (equivalence + test262 + quality) after the codemod.
- `bun build --compile` / `deno compile` of the CLI produce a standalone binary
  that runs `--optimize` with binaryen **embedded** (closes the #986 end-state).
- Migration guide note in README/CHANGELOG (breaking: `compile()` now returns a
  Promise).

## Risk / notes

- **Breaking public API change** — `compile()` returns a `Promise` now; every
  external consumer must `await`. Call it out prominently (README/CHANGELOG/major
  version bump).
- **Validate locally** — run the full suite (`npm test`) after the codemod and
  fix failures before pushing; CI is the final gate. Keep the PR **DRAFT** until
  green.
- The codemod is the risk centre — do it AST-based and review a sample diff
  before the repo-wide run.

## Implementation notes (senior-dev, 2026-05-31)

**Branch:** `issue-1757-async-compile-v2` · **PR:** feat(#1757) async compile() migration.

### What shipped (4 commits)
1. **Source (Phase 1)** — `compileSource`/`compileMultiSource`/`compileFilesSource`
   are `async -> Promise<CompileResult>`; the optimize step uses
   `await optimizeBinaryAsync`. `index.ts` `compile`/`compileMulti`/`compileFiles`/
   `compileToWat`/`compileProject` + `createIncrementalCompiler().compile` are async.
   `runtime.ts`/`runtime-instantiate.ts` await (already async fns); `cli.ts` awaits
   (top-level-await CLI); the test262/compiler workers await the now-async result.
2. **Test codemod (Phase 2)** — ts-morph AST codemod (`.tmp/codemod-async-compile.mjs`)
   over `tests/**/*.ts`: 2142 awaits, 1189 fns async, 769 files. Idempotent,
   collect-then-mutate, reverse-order, fixpoint propagation through named helpers
   (incl. `Promise<T>` return-type rewrite).
3. **Standalone embed (Phase 3)** — fixed the residual sync `require("binaryen")`
   in `optimizeWithBinaryenPackage` to use `process.getBuiltinModule("node:module")`
   -> `createRequire` so bundlers don't statically follow it. README + CHANGELOG.
4. **Playground/scripts/benchmarks** — same codemod over those consumers.

### WHY the key design choices
- **Synchronous `compileSourceSync` core.** The JS `eval` host shim
  (`runtime-eval.ts`, `__extern_eval`) is **inherently synchronous** — it returns
  the eval value directly to compiled Wasm via a host import and CANNOT become
  async without breaking eval semantics. Since `eval` never passes `optimize`
  (the only async step), I split the pipeline: `compileSourceSync` runs the full
  synchronous codegen with NO wasm-opt; `compileSource` (async) calls the sync
  core then applies `await optimizeBinaryAsync` over the produced binary. This
  keeps eval sync while making the public API async. The optimize step only
  mutates `result.binary`, so applying it post-hoc is behavior-preserving.
- **The real #986 blocker was the sync `require("binaryen")`, not just the API
  shape.** Binaryen's index.js has a top-level `await`. A *static*
  `require("binaryen")` makes esbuild/bun try to inline it through a sync require
  and fail hard (`This require call is not allowed because the imported file ...
  contains a top-level await`). Confirmed by bundling `compiler-bundle-entry.ts`
  with binaryen NOT externalized: it errored before the fix, and after routing
  the sync fallback through `createRequire` it produces a 13.8 MB bundle with
  binaryen embedded. The async `await import("binaryen")` path is the one that
  legitimately bundles binaryen for `bun build --compile` / `deno compile`.
- **`(await call)` wrapping + prettier cleanup.** The codemod always emits
  `(await compile(x))` so member/element access keeps correct precedence
  (`compile(x).binary` -> `(await compile(x)).binary`, never
  `await (compile(x).binary)`). Prettier then strips the redundant parens in
  plain-assignment positions. Zero `tsc --noEmit` errors across the whole repo
  after the codemod is the structural proof the propagation is complete.

### Validation
- `tsc --noEmit` (whole project): 0 errors after every codemod stage.
- Full `npm test` run locally. The failing files (e.g. `compiler.test.ts` 17/20,
  `ir-scaffold` 2/7, `jwt-decode`) were verified to fail **identically on a clean
  `origin/main` checkout** — pre-existing, not codemod regressions. No
  Promise-misuse signatures (`is not a function`, `undefined reading success/
  binary`, SyntaxError) anywhere in the run.
- `compile(..., {optimize:3})` end-to-end: loads binaryen via `await import`,
  optimizes, runs correctly.
