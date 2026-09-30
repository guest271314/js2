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
