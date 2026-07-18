---
id: 3433
title: "Test262 v8 harness-prelude compile cost: kill the quadratic per-call file rescans, then reuse prelude front-end work"
status: in-progress
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: perf
area: test262-runner
goal: test262-conformance
assignee: ttraenkler/fable-dev-7
related: [3370, 3431, 2612, 2767, 1046, 904, 33]
files:
  - src/codegen/expressions.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/context/types.ts
  - tests/issue-3433.test.ts
---

# #3433 — restore test262 shard speed after the oracle-v8 harness flip

## Problem

Pre-v8, the 114-shard test262 matrix averaged ~2 min/shard; after #3370 made
the literal upstream harness authoritative, host shards average ~13.6 min. The
v8 assembler prepends the REAL prelude (runtime shim 1,041 B + assert.js
4,594 B + sta.js 719 B = 6,354 B; + per-test includes, e.g. propertyHelper.js
12,072 B) to every one of ~43k tests, and passing tests compile TWICE (strict
rerun). The disk cache has been disabled since ~2026-07-05 ("stale cache
entries caused false baselines"), so every CI run compiles everything fresh.

## Measurements (darwin, M-series, compiler-bundle, worker-identical options)

Steady-state in-process `compile()` medians (8 runs), mirroring
`doCompile(originalHarness=true)`:

| shape | small-body test | map test | propertyHelper test |
| --- | --- | --- | --- |
| full assembly | 720 ms | 519 ms | **1,963 ms** |
| body only | 173 ms | 63 ms | 59 ms |
| prelude only | 528 ms | 575 ms | 2,176 ms |
| trivial `var x` | 0.7 ms | 0.7 ms | 0.7 ms |

So: (1) per-compile fixed overhead is nil (libs already cached in-process);
(2) the prelude is 75–97 % of every compile; (3) cost is **superlinear** in
source size (6.3 KB → ~530 ms, 18.4 KB → ~2.2 s).

CPU profile (inclusive % of process samples, `built-ins/Array/prototype/map`
full assembly):

- `compileSourceSync` 81.7 %
  - `generateModule` (codegen+emit) **70.1 %**
    - `visit` in `symbolBindsAsyncFunction` (expressions.ts, #2612) **39.9 %**
    - other statement/expression codegen ~30 %
  - `analyzeSource` (TS program+parse+bind) 7.6 % + `createProgram` 5.8 %
  - demand checker queries ~8 %

## Root cause

`isAsyncCallExpression()` ends with a fallback (`symbolBindsAsyncFunction`,
#2612) that walks the **entire source file** looking for `x = async function`
assignments — and it runs for **every ordinary sync call** (all async checks
fall through for `assert(...)`, `$ERROR(...)`, etc.). That is
O(call-sites × file-size): invisible on pre-v8 tiny wrapped bodies, quadratic
blow-up on v8's 6–18 KB assemblies. `resolveAssignedNominalType`
(calls.ts, #2767) mirrors the same full-file rescan for bare `var`/`let`
receivers (common in the upstream harness: `var x;` patterns in sta.js /
propertyHelper.js).

The "prelude recompiled tens of thousands of times" framing is the
multiplier; the *nonlinearity* is the real killer. Fixing the scans is a pure,
semantics-identical compile-work optimization (exactly the honesty bar: cache
compilation work, never verdicts).

## Plan (evidence-ordered)

1. **Linearize the async-assignment scan** — per-compile memo
   `ctx.asyncAssignScanCache: Map<ts.SourceFile, Set<ts.Symbol>>`: one walk
   per file collecting symbols assigned an async fn expression;
   `symbolBindsAsyncFunction` becomes a set lookup. Identical results by
   construction (membership test equals the original per-query scan).
2. **Linearize the ident-assignment scan** — per-compile memo
   `ctx.identAssignRhsCache: Map<ts.SourceFile, Map<ts.Symbol, ts.Node[]>>`
   shared by `resolveAssignedNominalType`; RHS `getTypeAtLocation` stays
   lazy per queried symbol (unchanged checker-call pattern for matches).
3. **Re-profile** the same samples; chase any remaining superlinear hotspot
   only if it still dominates.
4. **Validation**: (a) byte-compare compiled wasm for a ~30-test sample
   (across categories, incl. propertyHelper/strict/negative) before vs after —
   must be identical; (b) verdict-identical on that sample; (c) measured
   per-compile ratio reported below; (d) unit test pinning the memo behavior.
5. **Document (not implement)** the deferred options: front-end prelude
   snapshot (measured ceiling ~13 % — not worth the two-file diagnostics
   risk), compiled-prefix reuse (#1046-shaped linking work), and disk-cache
   re-enable (sound two-level key: assembled-source hash × bundle hash ×
   target; requires re-adding the actions/cache step removed with the
   "false baselines" disable).

## Checklist

- [x] Investigate: read runner/worker/assembler; profile; find root cause
- [x] Allocate id + claim lock + branch `issue-3433-test262-prelude-compile-cache`
- [x] Issue file with plan committed early (insurance)
- [ ] Fix 1: async-assignment memo
- [ ] Fix 2: ident-assignment memo
- [ ] Re-profile + record numbers
- [ ] Byte-identity + verdict-identity sample validation
- [ ] Unit test (tests/issue-3433.test.ts)
- [ ] typecheck + prettier + scoped suites (issue-3370 tests, 2961, chunk smoke)
- [ ] PR to loopdive/js2, report to coordinator

## Roadmap: lane-asymmetric harness strategy (user design input, 2026-07-18)

Documented for the next window; NOT in scope for this PR.

- **JS-host (V8) lane — policy option**: run the real assert.js/sta.js
  natively in V8 and compile only the test body. Not the #3370 rewriting-sin
  (harness stays unmodified), but it moves the measurement boundary: 
  Test262Error cross-boundary identity, `verifyProperty` MOP on wasm-created
  objects, and script-global sharing between harness and test become interop
  requirements — some failures would become boundary-artifacts rather than
  compiler-conformance signals. Needs a deliberate #3370-contract decision by
  the lane's owner + user before anyone builds it.
- **Standalone (wasmtime) lane — endorsed end-state**: a separately-compiled
  harness `.wasm` linked per test. This is the #1046 separate-compilation +
  #33 linker path (fresh spec on main); slice-1's scalar/externref boundary is
  insufficient for harness class-identity/script-global linkage, so the
  harness becomes the driving use case for the richer slices (see also #904).
- **This issue's scope stays**: in-compile work deduplication with
  zero honesty risk and byte-identical output.

## Results

(to be filled after implementation)
