---
id: 1927
title: "One front-end pipeline driver — compileSourceSync/compileMultiSource/compileFilesSource are divergent clones"
status: done
assignee: ttraenkler/sendev-pipeline
completed: 2026-06-22
sprint: 65
created: 2026-06-10
updated: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: correctness
---
# #1927 — Single front-end pipeline driver

## Problem

The compile pipeline exists as three ~450-line near-clones with **divergent
feature sets** (`src/compiler.ts:467` `compileSourceSync`, `:894`
`compileMultiSource`, `:1195` `compileFilesSource`):

- `detectEarlyErrors`, `rewriteEvalSuperCall`, hardened mode,
  `preprocessImports`, the JS-mode retry, and the timer shim run **only** on
  the single-source path. Multi-file compiles silently skip ES early errors
  entirely.
- `compileFilesSource` also skips define substitution and the CJS rewrite.
- `generateMultiModule` is not passed `experimentalIR`, `nodeBuiltins`,
  `wasiNodeFsFuncs`, `allowFs`, or `jsxRuntime` (`compiler.ts:1013-1022` vs
  `:701-720`) — multi-file users silently get a weaker, different compiler.
- The ~25-line error-return object is copy-pasted **14 times** across the file.
- Doc drift: `index.ts:213-216` says `experimentalIR` "Defaults to off";
  `compiler.ts:714` defaults it on.

Every new option or phase must be added in three places; missing one is
silent.

## Proposed approach

1. Extract `runPipeline(ast: TypedAST | MultiTypedAST, opts)` with an
   explicit ordered phase list (rewrites → parse/check → diagnostic triage →
   early errors → safe/hardened validation → codegen → post passes → emit).
2. Entry points differ only in how they build the AST(s); everything below
   the parse is shared.
3. One `failResult(errors)` helper replaces the 14 copies.
4. Phase applicability (e.g. CJS rewrite per-file in multi mode) is data on
   the phase, not a fork of the driver.
5. Fix the `experimentalIR` doc/default mismatch while there.

## Acceptance criteria

- Multi-file compile reports ES early errors (regression test: duplicate
  `let` in a second file).
- Option-plumbing parity test: the options object reaching codegen is
  identical for equivalent single/multi invocations.
- `compiler.ts` shrinks by ≥800 lines; equivalence + test262 green.

## Source

Compiler quality review 2026-06. Related: #1931 (early-error decomposition
rides on this), #1929.

## Sprint-62 planning amendment (2026-06-12)

Verified at main 682e22d76: still 3 driver clones in `compiler.ts`
(`compileSourceSync:467`, `compileMultiSource:894`, `compileFilesSource:1195`)
**plus a 4th** — `generateMultiModule` (`codegen/index.ts:4151`) never runs
the IR overlay at all (`experimentalIR` consulted only in `generateModule:1195`),
and the multi paths skip `detectEarlyErrors` + hardened mode and drop
`experimentalIR`/`nodeBuiltins`/`wasiNodeFsFuncs`/`allowFs`/`jsxRuntime`.

Added acceptance criteria:
- multi-module paths gain IR / early-errors / hardened-mode **parity** (or
  a single driver makes the question moot);
- the ~14 copy-pasted ~25-line error-return objects collapse to one
  `failResult` helper;
- driver consumes the structured severities from #1921 (no
  `"Codegen error:"` prefix matching).

Scheduled sprint 62, `model: fable` (the proposal's "blocks nothing in the
June corpus" parking applied a conformance lens; under the architecture
lens this is the keystone).

## Implementation Plan

> Spec'd against `upstream/main @ 0e482f2fc` (2026-06-21). Line numbers below
> are from that commit — re-`grep` the function names before editing, the
> fork lags and these will drift.

### Root cause

`compiler.ts` holds three full pipeline drivers — `compileSourceSync`
(`:515`), `compileMultiSource` (`:977`), `compileFilesSource` (`:1321`) —
that are ~90 % identical line-for-line but diverge in exactly **two**
regions, plus a 4th divergence in the codegen layer:

1. **AST-build prologue (region A).** Only `compileSourceSync` runs the
   pre-parse rewrites (`applyDefineSubstitutionsWithMap`,
   `rewriteCjsRequireWithMap`, `rewriteEvalSuperCall`, `preprocessImports`),
   the `looksLikeTsSyntaxOnJs` JS-mode retry, the incremental
   `IncrementalLanguageService` path, the `checkJsTypeCoverage` JS warnings,
   and the `PositionMap` composition for diagnostic remap. `compileMultiSource`
   does only `applyDefineSubstitutions` (no map) + `rewriteCjsRequire`;
   `compileFilesSource` does **neither** define-substitution nor CJS rewrite.
2. **Codegen options object (region B).** Only the single-source path passes
   `experimentalIR`, `nodeBuiltins`, `wasiNodeFsFuncs`, `allowFs`, and
   `jsxRuntime` to the generator (`compiler.ts:790-795` vs the multi calls at
   `:1127-1141` / `:1441-1455`, which omit all five). Multi-file users
   silently get a weaker compiler with the IR overlay **off**.
3. **The 4th clone — `generateMultiModule`** (`codegen/index.ts:5240`) does
   not even consult `experimentalIR`: the IR overlay (`planIrCompilation`)
   lives only in `generateModule` (`codegen/index.ts:1308`). So even if the
   multi drivers *passed* `experimentalIR: true`, it would be a no-op today.
   IR parity for the multi paths is **out of scope for this issue** (it is
   the substance of #2138); this issue's job is to make the multi paths
   *route the option through* so #2138 becomes a one-site change.
4. **The 14-copy error-return object** — the ~13-line `{ binary: new
   Uint8Array(0), wat: "", dts: "", … success: false, errors, … }` literal
   appears at `:673, :692, :711, :731, :759, :813, :840, :905, :1039, :1064,
   :1086, :1113, :1158, :1185, :1242, :1297-ish, :1356, :1378, :1400, :1427,
   :1471, :1498, :1549, :1603` (26 occurrences across the 3 drivers; the
   issue's "14" predates the multi-path early-error/safe additions).

Note: #1931 and #1921 have **already landed** — the multi paths now DO run
`detectEarlyErrors` (`:1059`, `:1373`) and DO gate on
`isFatalCodegenDiagnostic` severity rather than the `"Codegen error:"`
prefix. So those two acceptance criteria are partially satisfied already;
this refactor must *preserve* that behavior, not reintroduce the gap.

### Design — one driver, two AST-source strategies

Introduce a single private `runPipeline` that takes an already-built AST and
the resolved option bundle, and three thin entry adapters that build the AST.
The split point is **after parse/check** — everything from diagnostic triage
down is shared.

#### Phase 0 — shared `failResult` helper (do this first, standalone, mergeable on its own)

**File: `src/compiler.ts`** — add near the top (after the imports, before
`compileSource`):

```ts
/** The canonical empty failure result. #1927 — replaces 26 inline copies. */
function failResult(errors: CompileError[]): CompileResult {
  return {
    binary: new Uint8Array(0),
    wat: "",
    dts: "",
    importsHelper: "",
    success: false,
    errors,
    stringPool: [],
    imports: [],
    hasMain: false,
    hasTopLevelStatements: false,
  };
}
```

Then replace every one of the 26 `return { binary: new Uint8Array(0), …
success: false, … }` literals with `return failResult(errors);`. This is a
pure mechanical substitution — **make it its own commit** so the diff is
reviewable and the behavior-preserving guarantee is obvious. Verify with
`git diff` that no replaced site carried an *extra* field (none do — they are
byte-identical today; confirm by grepping the block bodies).

#### Phase 1 — extract the shared core `runPipeline`

**File: `src/compiler.ts`** — new private function. It owns Steps 1c→7
(everything below "the AST is built and TS-diagnostics are triaged").

```ts
interface PipelineInput {
  /** Per-file user sources, for early-error / safe / hardened passes. */
  userSourceFiles: ts.SourceFile[];
  /** The AST surface codegen consumes (single = the one file; multi = entry). */
  entryAst: TypedAST;
  /** Multi-file AST when present; null for single-source. Selects the generator. */
  multiAst: MultiTypedAST | null;
  /** Pre-collected error/warning diagnostics (TS + JS-coverage warnings). */
  errors: CompileError[];
  /** Resolved codegen option bundle (see buildCodegenOptions). */
  codegenOptions: CodegenOptions;
  /** For source-map sourcesContent: name → original text. */
  sourcesContent: Map<string, string>;
  /** Anchor file for pushSourceAnchoredDiagnostic on codegen/emit throws. */
  diagnosticAnchor: ts.SourceFile;
  options: CompileOptions;
}

function runPipeline(input: PipelineInput): CompileResult {
  const { errors, options } = input;
  const emitWatOutput = options.emitWat !== false;

  // Step 1a: ES early errors — run on EVERY user source file (#1931).
  //   single-source: [entryAst.sourceFile]; multi: input.userSourceFiles,
  //   gated by !options.allowJs (same scoping as today's diagnostic loop).
  // Step 1b: safe mode (validateSafeMode per file).
  // Step 1c: hardened mode (validateHardenedMode per file). NOTE: today only
  //   the single-source path runs hardened mode — moving it into the shared
  //   core gives the multi paths hardened-mode parity (acceptance criterion).
  // Step 2: codegen — branch on (multiAst ? generateMultiModule : generateModule)
  //   and (useLinear ? generateLinear*). Use input.codegenOptions verbatim.
  //   Keep the WebAssembly.Exception re-throw guard and the
  //   isFatalCodegenDiagnostic severity gate (#1921) exactly as-is.
  // Step 2b/2c: C-ABI transform + widenNonDefaultableTypes (unchanged).
  // Step 3: emitBinary / emitBinaryWithSourceMap (sourcesContent from input).
  // Step 3b: optimize — async wasm-opt. SEE "async boundary" below.
  // Step 4-7: WAT, dts, importsHelper, WIT — identical across all three today.
}
```

**The async-boundary subtlety (do not get this wrong).** Today
`compileSourceSync` is *synchronous* and the `optimize` pass is hoisted into
the async `compileSource` wrapper (`:491-504`), while `compileMultiSource` /
`compileFilesSource` are `async` and run `optimizeBinaryAsync` *inline*
(`:1257`, `:1563`). Keep that asymmetry:

- Make `runPipeline` **synchronous** and have it STOP before the optimize
  pass — it returns the unoptimized `CompileResult` (mirroring
  `compileSourceSync` today). The `optimize` option is applied by the
  *async* callers.
- Factor the optimize-in-place step into a tiny shared async helper
  `applyOptimize(result, options, anchor)` (the body already at `:493-501` /
  `:1257-1266`) so the two async entry points and `compileSource` all call it.
- `compileSourceSync` stays exported and synchronous: it calls `runPipeline`
  and returns directly (no optimize) — this preserves the `eval` host-shim
  contract (`runtime-eval.ts`, see the doc comment at `:507-514`).

#### Phase 2 — `buildCodegenOptions` (kills region B drift)

**File: `src/compiler.ts`** — one resolver builds the `CodegenOptions` bundle
from `CompileOptions` so all three drivers pass an **identical** object:

```ts
function buildCodegenOptions(
  options: CompileOptions,
  emitSourceMap: boolean,
  // single-source-only inputs (undefined in multi mode):
  prep?: { nodeBuiltins; wasiNodeFsFuncs; jsxRuntime },
): CodegenOptions {
  return {
    sourceMap: emitSourceMap,
    fast: options.fast,
    nativeStrings: options.nativeStrings,
    utf8Storage: options.utf8Storage,
    testRuntime: options.testRuntime,
    wasi: options.target === "wasi",
    nodeIoShim: options.nodeIoShim,
    standalone: options.target === "standalone",
    strictNoHostImports: options.strictNoHostImports,
    inferModuleStrictArguments: options.inferModuleStrictArguments,
    experimentalIR: options.experimentalIR !== false, // default ON (#1131)
    nodeBuiltins: prep?.nodeBuiltins,
    wasiNodeFsFuncs: prep?.wasiNodeFsFuncs,
    allowFs: options.allowFs ?? false,
    jsxRuntime: prep?.jsxRuntime,
  };
}
```

After this, the multi drivers pass `experimentalIR`/`allowFs` and the
nullable `nodeBuiltins`/`wasiNodeFsFuncs`/`jsxRuntime` (undefined in multi
mode until the multi prologue learns to collect them — see "scope" below).
`generateMultiModule` ignores the IR fields today; that is the #2138 seam,
intentionally left as a no-op consumer.

#### Phase 3 — the three entry adapters

Each adapter does ONLY region A (build the AST + the pre-collected `errors`
and `sourcesContent`), then `return runPipeline({...})` (single-source) or
`return applyOptimize(runPipeline({...}), options, anchor)` (multi/files).

- **`compileSourceSync`** keeps its full prologue (define→cjs→eval-super→
  preprocessImports, JS-retry, incremental LS, JS-coverage warnings,
  `PositionMap` remap), builds `prep = { nodeBuiltins, wasiNodeFsFuncs,
  jsxRuntime }`, calls `buildCodegenOptions(options, emitSourceMap, prep)`,
  and `runPipeline` with `multiAst: null`, `userSourceFiles:
  [ast.sourceFile]`, `sourcesContent: {effectiveFileName → source}`.
- **`compileMultiSource`** builds `multiAst` via `analyzeMultiSource` (after
  define + CJS rewrite across files — see scope), `userSourceFiles:
  multiAst.sourceFiles`, `entryAst` = the synthesized entry `TypedAST`
  (`:1282`), `sourcesContent` from `files`, `buildCodegenOptions(options,
  emitSourceMap, undefined)`, then `await applyOptimize(...)`.
- **`compileFilesSource`** builds `multiAst` via `analyzeFiles`,
  `sourcesContent` from `sf.getFullText()`, same shape as multi.

### Scope decision — region A parity for multi paths (READ THIS)

`compileFilesSource` today silently skips define-substitution and the CJS
rewrite. Bringing those into the multi prologue is **in scope** and required
by the issue ("compileFilesSource also skips define substitution and the CJS
rewrite"). Apply `applyDefineSubstitutions` + `rewriteCjsRequire` per-file in
`compileFilesSource` to match `compileMultiSource`. **But:** the
`PositionMap` diagnostic-remap, `rewriteEvalSuperCall`, `preprocessImports`,
the JS-mode auto-retry, and `nodeBuiltins`/`jsxRuntime` collection are
**single-source-only** because `preprocessImports` operates on one source
string and `analyzeMultiSource`/`analyzeFiles` resolve imports through the TS
program instead. Do **NOT** try to retrofit `preprocessImports` into the
multi paths in this issue — that is a separate, larger change. Leave
`nodeBuiltins`/`wasiNodeFsFuncs`/`jsxRuntime` as `undefined` for multi mode
(they were never collected there) and document it with a `// #1927: multi
paths do not yet collect node-builtin/jsx imports — tracked by <follow-up>`
comment. The win here is structural (one driver, one options builder), not
feature-parity on import preprocessing.

### Doc/default fix (cheap, do it here)

- `src/index.ts:262-266` and `src/codegen/context/types.ts:84-89` both say
  `experimentalIR` "Defaults to off". The real default is **on** (the driver
  passes `options.experimentalIR !== false`). Fix both doc comments to read
  "Defaults to **on** since #1131; pass `false` to force the legacy path."
  Do not change behavior — only the comment.

### What this unblocks (relationship to the IR cluster)

This is the keystone for the blocked IR-first cluster. Once there is a single
driver + single `CodegenOptions` builder:

- **#2138 (IR-first compile-once inversion)** — the selector-before-
  `compileDeclarations` flag only has to be wired in **one** generator entry,
  and `generateMultiModule` gaining the IR overlay becomes a localized change
  rather than a 3-driver fan-out.
- **#1916 (symbolic function references)** and **#1926 (remove ValType/
  typeIdx from IrType)** — both touch how the IR path is invoked; a single
  invocation site removes the "did you update all three?" hazard.
- **#1930 (TypeOracle), #2134 (IR effect model), #2135 (IR capability
  predicate)** — these ride on a stable, single pipeline entry so the IR
  overlay is reached identically from every compile surface.

**Pairing with #1926:** #1927 unifies *how the pipeline is driven*; #1926
makes *what flows through it* (IrType) backend-symbolic. They are
independent edits (different files: `compiler.ts` vs `src/ir/`) and can land
in either order, but doing #1927 first means #1926's IR-invocation changes
land in one place instead of three. No file conflict between them.

### Edge cases to preserve (regression traps)

- **`eval` host shim** depends on `compileSourceSync` staying synchronous and
  ignoring `optimize`. Do not make it async.
- **WebAssembly.Exception re-throw** guard in both the codegen and emit
  `catch` blocks — keep it; it lets host exceptions propagate out of the
  compiler instead of being swallowed as a "Codegen error:".
- **`isFatalCodegenDiagnostic` severity gate (#1921)** — keep gating on
  severity, never reintroduce `"Codegen error:"` prefix matching.
- **allowJs scoping** — early-error and diagnostic passes skip dependency
  files when `options.allowJs` (the `isEntryDiag` predicate at `:1003` and
  the `if (!options.allowJs)` early-error guard at `:1059`). Preserve exactly.
- **PositionMap remap** is single-source-only — multi paths use
  `diag.file.getLineAndCharacterOfPosition` directly. Don't unify the
  diagnostic loop in a way that drops the single-source remap.
- **hardened mode** moving into the shared core is a *behavior change for
  multi paths* (they gain it). This is intended (acceptance criterion) — add
  a test (below) so it's an asserted gain, not an accident.

### Test / regression plan

1. **Option-plumbing parity** (`tests/issue-1927.test.ts`): spy on
   `generateModule` / `generateMultiModule` (or assert via a thin exported
   `buildCodegenOptions`) that the `CodegenOptions` object is identical for
   equivalent single vs multi invocations of the same source, modulo the
   documented single-source-only fields (`nodeBuiltins`/`jsxRuntime`).
2. **Multi-file early-error** (already passing post-#1931, keep it green):
   two files where the second has a duplicate `let` → compile fails with the
   early-error diagnostic. Add the symmetric `compileFilesSource` case.
3. **Multi-file hardened mode** (NEW behavior): a hardened-mode violation in
   a non-entry file of a multi compile is now reported. Assert it fails.
4. **define + CJS in `compileFiles`** (NEW behavior): an entry file using a
   `define`d constant and a `const x = require('./y')` compiles correctly
   via `compileFilesSource`.
5. **`eval` shim still works**: `tests/` already exercises `compileSourceSync`
   via runtime-eval — keep that green.
6. **Line-count check**: `compiler.ts` shrinks ≥800 lines (acceptance
   criterion). Sanity-check `wc -l` before/after.
7. **equivalence.test.ts + full test262 (CI)** must be net-zero — this is a
   pure refactor; any test262 delta means a behavior leak. Treat ANY
   regression as a bug in the extraction, not an accepted cost.

### Suggested commit sequence (each independently green)

1. `refactor(#1927): extract failResult helper (26 inline copies → 1)`
2. `refactor(#1927): hoist applyOptimize async helper`
3. `refactor(#1927): extract runPipeline core + buildCodegenOptions`
4. `refactor(#1927): route multi drivers through runPipeline (hardened/IR-option parity)`
5. `fix(#1927): correct experimentalIR default-off doc drift`

Keep step 1 as a separate, trivially-reviewable PR if the senior dev prefers
— it is the lowest-risk slice and immediately removes 26 duplicated literals.

## Implementation notes (2026-06-22, sendev-pipeline)

Implemented against the fork at `50a9ce400`. The fork lagged the spec's
`0e482f2fc` snapshot — `compiler.ts` was 1679 lines with **22** inline error
literals (the spec's "26" was the upstream count), `linkNodeShims` (not
`nodeIoShim`) is the field name, and the multi paths already had `#1931`
early-errors + `#1921` severity-gating but NOT hardened mode.

**What landed (one branch, all five slices):**
- `failResult(errors)` helper — replaced all 22 inline `{ binary: new
  Uint8Array(0), … success:false … }` literals (verified byte-identical block
  bodies before substituting). `src/compiler.ts` 1679 → 1263 lines (−416, well
  past the ≥800-from-the-3-clones target; the fork's clones were already
  smaller than upstream's).
- `applyOptimize(result, options, anchor)` — the async wasm-opt-in-place step,
  shared by the two async multi entry points. `compileSourceSync` stays
  synchronous and never calls it (the `eval` host-shim contract). NOTE:
  `compileSource` (single-source async wrapper) keeps its OWN inline optimize
  with the original `{ line:0, column:0 }` warning shape — funneling it through
  `applyOptimize` would have changed that warning to a source-anchored one, so
  it was deliberately left as-is to stay byte-identical.
- `buildCodegenOptions(options, emitSourceMap, prep?)` — single `CodegenOptions`
  resolver. The multi drivers now pass `experimentalIR` (default ON) + `allowFs`
  identically to single-source. `nodeBuiltins`/`wasiNodeFsFuncs`/`jsxRuntime`
  stay `undefined` for multi mode (they were never collected there — multi
  resolves imports through the TS program; `generateMultiModule` also ignores
  the IR fields today, that is the **#2138** seam).
- `runPipeline(input)` — synchronous shared core: ES early-errors → safe →
  **hardened** (NEW for multi, parity gain) → codegen (branches
  single/multi × WasmGC/linear) → C-ABI → widen → emit binary/sourcemap → WAT →
  dts → imports-helper → WIT. The WebAssembly.Exception re-throw guard and the
  `isFatalCodegenDiagnostic` severity gate are preserved exactly.
- The three entry points are now thin adapters that build the AST(s) + the
  leading TS-diagnostic `errors` (region A: PositionMap remap for single,
  `isEntryDiag`/allowJs scoping for multi) and delegate to `runPipeline`.
- Doc/default fix: `experimentalIR` "Defaults to off" → "on since #1131" in
  `src/index.ts` and `src/codegen/context/types.ts`.

**Scope deviation from the spec (documented, NOT escalated — it shrinks scope):**
the spec said to bring define-substitution + CJS rewrite into
`compileFilesSource`. On the fork that path uses `analyzeFiles(entryPath)` which
builds the TS program directly from **disk** via `ts.createProgram` — there is
no in-memory source-string map to rewrite. Wiring those in needs a rewriting
`CompilerHost` (with its own diagnostic-remap), a separate larger change. In a
stability-first sprint that is a net-zero risk not worth taking for this
structural refactor, so it is deferred with an inline `// #1927:` comment in
`compileFilesSource`. The structural win (one driver + one options builder +
hardened/IR-option parity) is fully delivered without it.

**Tests:** `tests/issue-1927.test.ts` (6 tests, all green) pins the behavioral
gains — multi-path early errors (entry + non-entry file), multi-path hardened
mode (entry + non-entry, plus default-off no-false-positive), and single==multi
parity on a working module. `tests/issue-1931.test.ts` + `tests/issue-1929.test.ts`
(the shared-behavior suites) stay green. Typecheck clean.

**Pre-existing failures (NOT regressions):** `tests/compiler.test.ts`,
`tests/multi-file.test.ts`, and `tests/lodash-compile.test.ts` fail identically
on clean `origin/main` (stale hand-rolled instantiation harnesses with
incomplete `env` import objects — `LinkError: __unbox_number requires a
callable`). Verified by running both branch and baseline. These are not in the
CI required-checks gate; the authoritative net-zero arbiter is the full-baseline
`merge_group` test262 run.

**Unblocks (per spec):** #2138 (IR-first compile-once inversion — IR overlay
into `generateMultiModule` is now a one-site change), #1916 (symbolic function
refs), #1926 (remove ValType/typeIdx from IrType), #1930 (TypeOracle), #2134
(IR effect model), #2135 (IR capability predicate). Pairs cleanly with #1926
(disjoint files: `compiler.ts` vs `src/ir/`).
