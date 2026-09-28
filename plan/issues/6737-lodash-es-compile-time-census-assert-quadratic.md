---
id: 6737
title: "perf: lodash-es standalone compile takes 10-17 min — 61 % is a whole-program module-init census check run once per module"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6720, 6704, 3525]
---

# #6737 — lodash-es compile time: the per-module census assert is quadratic

## Problem

After [#6720](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6720-standalone-lodash-es-module-init-null-property-regression)
the lodash-es `standalone-dynamic` lane is `measured` locally (checksum
54 = 54), but CI runs the lane in a child process with a **120 s compile
budget** (`standaloneLaneInChild`, `report.compile?.timeoutMs ?? 120_000`).
The compile takes **1,026 s** in the lane (optimize level 4) and **838 s**
without `wasm-opt`, so CI can only ever report the budget overrun.

## Measured

`compileProject` on the lane driver (`package/lodash.js`, `words` +
`kebabCase`, lane options, `optimize: 0`), `JS2WASM_COMPILE_PROFILE=1` plus
`node --cpu-prof`, main `e16ace7ca0` + #6720. Box load was 150-250 on 8
cores, so absolute times are inflated; the shares are what matter.
888 s sampled.

| # | hotspot | inclusive | share |
|---|---|---|---|
| 1 | `assertMultiPreparedModuleInitCensusCurrent` (`src/codegen/multi-prepared-module-init-census.ts`) | 544.7 s | **61 %** |
| 2 | `lib-globals-scan` phase → `collectDeclaredGlobals` (`src/codegen/extern-declarations.ts`) | 53.6 s | 6 % |
| 3 | first module-init pass, `_freeGlobal.js/module-init-pass1` | 43.3 s | 5 % |

Harness overhead outside the compiler: tsx module loading ~36 s.

### 1 — census assert (61 %)

Called from `#stateForBodySource` (306.9 s) and `#stateForOverlaySource`
(235.7 s) in `src/codegen/multi-prepared-program.ts`, i.e. **once per module
body and once per module overlay** (~640 modules → ~1,300 calls). Every call
re-validates **every** source:

- `currentSourceSyntax` re-walks the whole AST of every source and
  `JSON.stringify`s every node (`nodeSyntaxScalarFields` 41.9 s self);
- `census.identityContext.inventory.sources.find(…)` per source — O(S²);
- `terminalRecordsFor` = `inventory.terminalUnits.filter(…)` per source —
  O(S·T), 86.2 s self;
- `captureLegacyObservation` filters `staticEntries` and `moduleStatements`
  per source — O(S·E), 190.9 s self, plus 133.8 s in its filter callbacks.

So the compile does O(S) calls × O(S·(S+T+E) + N) work. Self-time split:
`captureLegacyObservation` 190.9 s, anonymous callbacks in the census file
133.8 s, `terminalRecordsFor` 86.2 s, `nodeSyntaxScalarFields` 41.9 s, the
assert body 35.6 s, `sameIdentityArray` 9.4 s.

### 2 — lib-globals scan (6 %)

`generateMultiModule` calls `collectDeclaredGlobals(ctx, libSf, sf, libIndex,
multiAst.sourceFiles)` for every (lib `.d.ts` × user source that uses lib
globals), and each call re-walks **all** user files (`allUserFiles`) to collect
referenced names. O(L · S · N) for a result that depends only on the user
files.

### 3 — first module-init pass (5 %)

43.3 s for `_freeGlobal.js`, whose body is one line
(`typeof global == 'object' && global && global.Object === Object && global`).
Most likely the one-time realm-object seed (every constructor carrier and its
prototype) charged to the first module that reads a global. Not confirmed —
needs a narrower profile of that pass.

## Suggested fixes

1. **Census assert.** Two layers:
   - trivial and output-neutral: build `sourceId → source`, `sourceId →
     terminals`, and `sourceFile → static entries / module statements` once
     per call instead of filtering per source;
   - the structural fix: re-check only the source being entered (the syntax
     walk and legacy snapshot of that source), or gate the full re-check
     behind a mutation counter. This decides what the invariant must still
     catch, so it needs the census owner's call (#3525).
2. **Lib scan.** Collect the referenced / value-referenced name sets once
   per `allUserFiles` (memoize by the array) instead of once per (lib × source).
3. **First init pass.** Profile it on its own before changing anything.

## Acceptance

- lodash-es `standalone-dynamic` compiles inside the lane's 120 s child
  budget on CI, or the remaining cost is itemized with the next hotspot.
- The emitted binary is byte-identical before and after each change.
