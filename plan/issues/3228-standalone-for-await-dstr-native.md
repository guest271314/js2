---
id: 3228
title: "standalone: for-await-of with a DESTRUCTURING binding over an ARRAY source falls to the legacy host-CPS lowering (24 leaky passes) — widen the native async-iterator DRIVE admission"
status: done
completed: 2026-07-13
sprint: 71
assignee: ttraenkler/opus-gapmap
created: 2026-07-13
updated: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, standalone
language_feature: async, for-await-of, destructuring
goal: standalone-mode
umbrella: 3178
related: [3178, 2906, 3132, 2602, 1930]
origin: "2026-07-13 opus-gapmap standalone leaky-column measure-first: the only genuinely-unclaimed bounded leaky de-leak. #3178 slice S4."
# (#3102) Intentional growth: the dstr-head admission arm in analyzeForAwait +
# the pattern-name spill exclusion + the destructuring post-deliver hook live
# next to their for-await siblings in async-cps.ts (the for-await planner owns
# this seam); async-frame.ts gets the single additive postDeliverEmit call.
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
---

# #3228 — native async-iterator drive for `for await` with a destructuring binding

## Problem (measured)

The single largest UNCLAIMED bounded slice of the standalone leaky-pass column
(#3178). `for await (const x of source)` with a plain **identifier** binding
already takes the native async-iterator DRIVE (#2906 slice 3b) and is host-free.
But a **destructuring** binding — `for await (const { a } of …)` /
`for await (const [a, b] of …)` — is rejected by `analyzeForAwait`
(async-cps.ts:1406-1408, `if (!ts.isIdentifier(decl.name)) return null`), so the
whole async function falls to the legacy host-CPS lowering that emits
`env::__make_callback` + `env::Promise_resolve/reject/then2` +
`env::__get_caught_exception`.

Measured on the fresh standalone baseline (2026-07-13, official scope):
**120 leaky passes** under `language/statements/for-await-of/async-func-dstr-*`.

**Corrected scope (measure-first, 2026-07-13).** The 120 split by SOURCE shape:
- **24 array-source** (`for await (const {a} of [ … ])`) — the bounded slice
  THIS issue flips. Verified: all 24 now compile host-free AND pass on the
  standalone lane (`runTest262File(..., "standalone")` → `{pass: 24}`, zero
  non-pass).
- **96 `asyncIter` async-generator-VAR source** (`var asyncIter = (async
  function*(){…})(); for await (const {…} of asyncIter)`) — a SEPARATE blocker:
  an async-generator instance held in a VARIABLE is not natively driven even for
  an IDENTIFIER binding (`resolveAsyncGenNextHelperName` matches only a direct
  call `g()`, not a var; `elementFactOf(asyncIter)` is unresolvable so the sync
  carrier declines too). That is the async-gen-consumer-over-var-source gap =
  **#3132's lane**, NOT a destructuring gap. Out of scope here; a follow-up
  extends the async-gen consumer (`planForAwaitAsyncCfg`) to var-held sources
  AND dstr, coordinated with #3132.

## Root cause

`analyzeForAwait` accepts ONLY `for await (const <ident> of …)`. The bounded
for-await drive machine (#2906) delivers the settled element into the resume
binding via a single `local.set` (`emitDeliver`, async-frame.ts:1304-1329).
A destructuring head needs IteratorBindingInitialization (§8.5.2 / §14.7.5.3
ForIn/OfBodyEvaluation) on the settled element instead of a scalar assignment —
which the SYNC for-of path already implements
(`compileForOfDestructuring`, loops.ts:1373).

## Fix (surgical — widen admission, no new machinery)

Reuse the settled element (already an externref in the drive: `L.value`,
async-cps.ts:1573, and `SENT_FIELD` is externref) and run the EXISTING sync
for-of destructuring helper against it.

1. **`analyzeForAwait` (async-cps.ts):** accept an object/array binding pattern.
   `ForAwaitShape` gains `pattern?: ts.ObjectBindingPattern | ts.ArrayBindingPattern`.
   For a pattern head, set `binding.name` to a synthetic element local
   (`__forawait_elem`, externref) — the resume machinery delivers the settled
   element into it UNCHANGED.
2. **Resume delivery (post-deliver hook):** `AsyncCfgState` gains an optional
   `postDeliverEmit?: AsyncCfgStepEmit`; `buildStateBody` (async-frame.ts) calls
   it once, right after `emitDeliver`. The sync `planForAwaitCfg` sets it on the
   resume state to `compileForOfDestructuring(ctx, fctx, pattern, elemLocal,
   {externref}, forStmt)` (element local looked up from `__forawait_elem`).
   This is the ONLY touch to the shared frame machinery — a single additive hook,
   no change to `emitDeliver`, spill layout, or `resumeBindingValType`.
3. **`compileForOfDestructuring` (loops.ts):** export it (module-private today).
4. **Async-gen coordination (stay out of #3132's lane):** keep the async-gen
   CONSUMER path (`forAwaitAsyncNeedsDrive` / `planForAwaitAsyncCfg`)
   identifier-only (add `shape.pattern === undefined`); and in the SYNC
   `forAwaitNeedsDrive` / `planForAwaitCfg`, exclude async-gen sources for
   pattern shapes. Net: dstr over an async-gen source stays on legacy
   (unchanged, no regression); dstr over an array/boxed source gets the native
   drive (the 120-test win). #3132 owns the async-gen dstr follow-up.

## Edge cases

- Element is `null`/`undefined` → destructuring must throw TypeError
  (`emitNullGuard`, inherited from `compileForOfDestructuring`).
- Nested patterns (`const { a: { b } }`), array patterns, defaults, rest —
  all handled by `compileForOfDestructuring` (the sync for-of path already
  passes these).
- Externref element representation → routes to
  `compileExternrefObjectDestructuringDecl` / `...ArrayDestructuringDecl`
  (`__extern_get`), the same path standalone sync for-of dstr uses.

## Validation

- Leak probe: `for await (const {a} of [{a:1}])` compiles standalone with ZERO
  family `env::` imports AND `WebAssembly.instantiate(binary, {})` succeeds.
- Construct-sampled corpus flip (leaky → host-free), never directory-sampled.
- `prove-emit-identity`: gc/host lane byte-identical (ctx.standalone-gated →
  NET≥0 by construction); wasi unchanged.
- Full standalone lane runs ONLY in `merge_group` (standalone-highwater floor
  #2097) — scoped-green is provisional.

## Expected floor delta

**+24 leaky → host_free_pass** (measured, verified). The remaining 96
`asyncIter`-source files need the #3132 async-gen-var-source drive first
(follow-up). Part of banking the #3178 family.
