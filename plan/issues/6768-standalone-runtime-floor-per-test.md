---
id: 6768
title: "perf(codegen): every standalone test262 compile rebuilds and walks a ~650-function runtime floor, 39 % of it unreachable"
status: in-progress
sprint: current
priority: high
horizon: l
goal: maintainability
reasoning_effort: max
assignee: ttraenkler/claude-lead
requested_by: ttraenkler/claude-lead
created: 2026-09-30
related: [6759, 6722, 6723]
---

# #6768 — the standalone runtime floor dominates per-test compile time

## Problem

After #6759 (merge-queue standalone shard median 657 s → 505 s), no single
pass dominates a standalone test262 compile any more. The cost is the **size
of every module**: a 330-line test compiles to 670 functions / 136k
instructions / 474 KB, and every whole-module pass walks all of it.

Measured 2026-09-30 on main `54a85ebdda`, the 40-row seed-7 sample
(`.tmp/prof/files.txt`), `JS2WASM_COMPILE_PROFILE=1`, 52.8 s total:

| phase | share |
|---|---:|
| `codegen` self (≈20 unlabelled whole-module passes, 1–3 % each) | 44.9 % |
| `bodies/module-init-pass1` + `pass2` (test + harness code) | 17.3 % |
| `finalize/*` repair passes (ir-inline, stack-balance, cross-hierarchy, peephole, extern-convert-any, repair-struct) | ~26 % |
| `finalize/dead-layout` | 5.8 % |
| `emit-binary` | 3.6 % |

Per-module scale (`[js2:profile] scale before-finalize`): 670–1391 functions,
136k–358k instructions. The function count going into finalize equals the
count in the emitted binary: `eliminateDeadImports`
(`src/codegen/dead-elimination.ts`) is the only dead-code sweep and it removes
imports, not functions.

### Reachability (measured)

`wasm-opt --all-features --remove-unused-module-elements` over the same 40
rows (script `.tmp/prof/reach.mts`):

- functions **28,399 → 17,385** — **61.2 % reachable**, 38.8 % dead;
- bytes 21.9 MB → 16.1 MB (73.5 %);
- per row 58–62 % reachable, very uniform;
- even a trivial row keeps ~400 reachable functions — the **runtime floor**.

## Two levers — do both

### Lever 1 — sweep unreachable functions before the finalize passes

Add a function (and dependent global/type) reachability sweep between body
compilation and the first finalize pass, so repair-struct, peephole,
ir-inline, cross-hierarchy, stack-balance, extern-convert-any and emit walk
~61 % of today's functions.

- Roots: exports, start function, element segments / `ref.func` targets,
  declared-func-refs (`collectDeclaredFuncRefs`), anything the runtime-eval /
  host ABI calls by index or name, and the program-ABI plan
  (`eliminateDeadLayoutAndPlanProgramAbi`, `src/codegen/program-abi-finalization.ts`).
- Edges: `call`, `return_call`, `ref.func`, plus any index-carrying
  side tables the codegen keeps (trampolines, closure exports, vtables).
- Remap function indices with the same machinery `eliminateDeadImports`
  uses (late index shifts are a known hazard — see CLAUDE.md
  "addUnionImports").
- Acceptance: output **validates**; test262 standalone verdicts unchanged
  in the merge group (edition ratchet, #1897 guard); host lane unaffected or
  also gated; equivalence gate no new failures; measured compile time on the
  40-row sample and merge-queue shard median reported.

### Lever 2 — build the runtime floor once per process, reuse it per test

The ~400 always-reachable runtime functions are identical across tests with
the same compile options. Compile them once per worker process (keyed by the
compiler bundle hash + the option fingerprint that affects runtime
emission), snapshot the resulting functions/types/globals, and seed each
test's module from a clone of the snapshot instead of regenerating them.

- First step is a measurement: which runtime helpers are emitted
  unconditionally vs on demand, and whether their bodies are byte-identical
  across the 40 rows. Only the invariant part is snapshotted.
- Clone must be deep (instruction arrays are mutated by finalize passes —
  see #6759's sharing analysis).
- Acceptance: **byte-identical** output vs its own base (main, or main +
  lever 1 if that lands first) on the 40-row sample
  and the equivalence corpus; compile time reported the same way.

## Measurement protocol

Both levers report: 3 interleaved base/new rounds on the 40-row sample, no
profiler (as in #6759), plus merge-queue standalone shard median/max after
merge. Capture `.tmp/base` copies at the first edit (CLAUDE.md).

## Lever 2 implementation

**Status: not implemented — stopped at the step-1 measurement (2026-09-30,
senior-dev, Opus 5 Max).** The brief's own gate applied: the invariant part
is too small and too entangled to snapshot under the byte-identity
acceptance. Nothing under `src/` changed.

### What was measured

40-row seed-7 sample (`.tmp/prof/files.txt`), `target: "standalone"`, base
`0dbe04213b`; 36 rows produce a module (4 are early-error rows with an empty
binary). Tools: a final-binary parser (name section + code bodies) and
temporary `mod.{types,functions,globals}` checkpoints in `generateModule`
(reverted; not committed).

**1. The runtime floor is emitted lazily, in first-demand order, during body
compilation.** Function counts at checkpoints (mean [min–max] over 36 rows):

| checkpoint in `generateModule` | types | functions | globals |
|---|---:|---:|---:|
| after `createCodegenContext` | 10 | 0 | 0 |
| before `collectAllSourceImports` | 19 [19–21] | 0 | 0 |
| after `collectAllSourceImports` (native string/number runtime) | 78 [77–82] | 86 [86–87] | 29 |
| before `bodies` | 90 [84–110] | 101 [94–127] | 36 [30–55] |
| before `finalize/dead-layout` | 451 [385–849] | 789 [668–1469] | 882 [711–1923] |

~87 % of each module's functions — including everything in the ~400-function
floor beyond the first ~86 string/number helpers — are created *inside*
`bodies`, when some expression first demands them. The user/harness
function slots sit at index ~86–93, and the helpers follow in demand order,
interleaved with source-dependent types and globals.

**2. Common does not mean invariant.** 630 function names occur in all 36
rows, but:

- only **62** sit at the same function index in every row (the common prefix
  is exactly the string runtime; it breaks at index 62:
  `__str_to_number` vs `parseFloat`);
- only **83** have byte-identical final bodies. The rest differ in type,
  function and global indices, e.g. `__str_copy_tree` is `(type $147)` with
  a `(ref null $1)` param in one row and `(type $204)`/`(ref null $5)` in
  another;
- the common name+body prefix is **0** — even the first helper differs,
  because source-dependent type reservations (`reserveTypedArraySubviewTypes`,
  `reserveObjVecArrType`, `collectDynamicObjectReturnCarrierTypes`, …) run
  before it. Module state already diverges before `collectAllSourceImports`
  (types 19/20/21). After it, the modal state (86 funcs / 77 types /
  29 globals) is shared by only 22 of 36 rows.

So a snapshot that stays byte-identical to base can cover at most the ~86
functions emitted before `bodies`, and only for rows with the modal
fingerprint. Seeding the other ~400 floor functions from a snapshot means
emitting them up front in a fixed order. That changes every function, type
and global index, so every binary changes, which the acceptance forbids.

**3. The cost it could remove is small.** Timing from exact checkpoint
timestamps (36 rows, no profiler, ~60 s total):

| segment | time | share |
|---|---:|---:|
| start → before `collectAllSourceImports` | 3.28 s | 5.4 % |
| `collectAllSourceImports` (the only snapshot-safe window, scan included) | 2.18 s | 3.6 % |
| → before `bodies` | 2.26 s | 3.7 % |
| `bodies` + unlabelled post-body passes → before finalize | 24.10 s | 40 % |

CPU profile (`--cpu-prof`, same 40 rows, 65.1 s sampled): inclusive time
under all `ensure*`/`emit*` helper builders is **3.8–9.6 %**. That is a lower
bound, because deep codegen stacks truncate, but it is the same order. The
dominant self time is whole-module walks: `stack-balance` 5.8 %, `ir-inline`
5.7 %, `instruction-walk` 5.4 %, `call-arg-producers` 2.7 %, `fixups` 2.6 %,
`dead-elimination` 2.6 %, plus TypeScript 13.6 % and GC 9.7 %. Those walks
scale with the module's function count, and a snapshot does not shrink it,
because the cloned functions would still be walked by every finalize pass.
Lever 1 does shrink it. The pure data tables are already memoised per process
(`enumerateClassRanges` has `enumCache`; `generalCategorySpans` and
`ensureRyuTables` cache too), so they are one-time warm-up, not per-test cost.

**4. Entanglement.** A seedable snapshot would have to deep-clone not just
`mod` but the `CodegenContext` registries that index it: 534 declared
fields, of which 236 are `Map`/`Set` registries (`funcMap`,
`nativeStrHelpers`, type caches, …), before counting the inherited
interfaces. Any registry missed silently re-emits a helper or points at a
stale index.

### Narrower proposals

1. **Do lever 1 first.** It is the lever that removes the ~39 % dead
   functions from every whole-module pass, and those passes are where the time
   goes.
2. **A pre-`bodies` snapshot is not worth doing.** Even for the modal
   fingerprint it saves at most ~3.6 %, and it needs a fingerprint over every
   source-dependent reservation made before `collectAllSourceImports`, plus a
   deep clone of ~236 registries.
3. **A fixed runtime prelude only works if byte-identity is relaxed** to
   "validates + test262/equivalence verdicts identical". Then the always-used
   helpers could be emitted up front from a per-process relocatable cache.
   The ceiling is helper-construction time (≈4–10 %), and it overlaps with
   lever 1 (the sweep deletes the unused ones anyway). Re-measure only after
   lever 1 lands.
4. **Candidate lever 3: TypeScript front end.** TypeScript is 13.6 % of
   compile CPU. The harness include set is re-parsed and re-checked for every
   test. That is the largest per-test invariant left that could stay
   byte-identical, since it is input processing, not emission order. It needs
   its own measurement first: the harness is currently concatenated into a
   single `test.js`, so prefix `SourceFile` reuse is not a drop-in change.
