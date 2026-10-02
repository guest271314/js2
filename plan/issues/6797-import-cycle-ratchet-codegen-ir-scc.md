---
id: 6797
title: "arch: codegen, ir and frontend form one 693-file strongly-connected component (40 % of src, 3,083 circular chains) — add an import-cycle ratchet and cut the 74 ir→codegen edges first"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: compiler-architecture
related: [912, 1172, 3113, 4601, 6793, 6808]
assignee: "ttraenkler/claude-dev-6797"
branch: "claude/issue-6797-import-cycle-ratchet"
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — arch #1/#2"
---

# #6797 — the documented IR retirement path cannot be executed layer-by-layer

## Measurements (2026-09-30, HEAD e303c5c7)

- `src/` = 904,803 lines / 1,738 files; 48 files > 3,000 lines;
  `src/codegen/` has **824 files (473,840 lines) flat** in one directory.
- Tarjan SCC over value imports (3,345 type-only imports excluded): 5 SCCs;
  the largest is **693 files** (681 codegen + 11 ir + 1 frontend); 105 mutual
  A↔B pairs. `madge --circular src/index.ts`: **3,083** circular chains over
  1,569 files. Example: `codegen/stdlib-selfhost.ts → frontend/builtins/build-ir.ts
  → ir/from-ast.ts → … → codegen/function-body.ts`.
- Directory-level two-way edges: codegen↔ir **310 / 74**, backend↔ir 97/20,
  frontend↔ir 17/7, codegen-linear↔ir 9/4, checker↔ir 1/8, ir↔runtime 7/1.
- Fan-out leaders: `codegen/index.ts` 279 imports, `expressions/calls.ts` 139,
  `ir/integration.ts` 109. God functions in `codegen/index.ts`:
  `generateModule` 1,909 lines (`:5229`), `generateMultiModule` 1,301
  (`:10552`), `planIrOverlay` 650, `emitIteratorMethodExport` 621,
  `resolveWasmType` 556. `check:godfiles` is **red on main** (two new
  mega-functions) and is not run in CI.
- `docs/architecture/codegen-axes.md` says the IR "replaces the hacks";
  `plan/log/ir-adoption.md`: 20 ir-owned / 31 mixed / 1 direct-only / 14
  deferred. The `*-native.ts` → `src/backend/wasmgc/` move
  (`target-architecture.md`) is half done: 42 files in `codegen/`, 49 in
  `backend/wasmgc/`, no progress marker. #912 (done) removed cycles once;
  nothing prevents them from returning.

## Correction

1. **Ratchet, not a big-bang.** `scripts/check-import-cycles.mjs`: Tarjan over
   `import … from` (value imports only), baseline
   `scripts/import-cycles-baseline.json` = {largest SCC size, total chains,
   per-directory two-way edge counts}. Fails on growth; `--update-on-decrease`
   banks improvements post-merge (same shape as `check:ir-fallbacks`). Wire
   into `quality`.
2. **Cut ir → codegen first (74 edges).** The IR must not import the legacy
   backend; each edge is either a shared type (move to `src/shared/`), a
   helper both need (move to `src/backend/wasmgc/`), or a real dependency
   inversion (inject via the `IrBackend` interface). List the 74 edges in a
   follow-up slice issue with an owner each.
3. **Directory budget for `src/codegen/`.** A `check:flat-dir-budget` that
   fails when `src/codegen/*.ts` (non-recursive) grows; new files go into the
   sub-directories the layout already has.
4. Put `check:godfiles` in `quality` (after refreshing its baseline in the
   same PR — it is red today), or delete it.

## Acceptance

- `pnpm run check:import-cycles` exists, is required in `quality`, and its
  baseline is committed with the numbers above.
- ir → codegen value-import count reaches 0 (tracked in the baseline);
  `docs/architecture/codegen-axes.md` gets a "how to verify" line pointing at
  the script.
- `src/codegen/` flat file count does not grow.

## Follow-up: `check:godfiles` stays out of `quality` (Correction item 4)

Not wired, and its baseline (`scripts/godfile-profile-baseline.json`) is not
refreshed: making it green would RAISE 24 per-function ceilings and add 23 new
ones, which is relaxing the gate, not refreshing it. Measured 2026-10-02 on
`39cc565790` with `node scripts/profile-godfiles.mjs --check` (exit 1,
47 regressions; the 2026-09-30 review's "two new mega-functions"
undercounts it). Old→new LOC, or `new` for a
function over the 150-LOC tracking floor that the baseline does not know:

- `src/codegen/index.ts` (20): generateModule 1269→1910, generateMultiModule 768→1302, planIrOverlay 554→651, emitIteratorMethodExport 169→622, resolveWasmType 380→557, emitToPrimitiveMethodExports 419→516, buildIrClassShapes 298→512, emitDispatchForMethod 411→479, ensureStructForType 380→453, emitMethodDispatch new 441, walkStmtForLetConst 208→284, planIrFirstBodyRouting 158→278, emitClassMemberKindExports new 264, registerImportBindingAliases new 245, buildDispatch 162→235, aliasOneBinding new 219, hoistVarDecl new 201, registerReassignedFunctionGlobals new 197, emitExternrefClassVarargDispatch new 160, preparedExactLexicalModuleInit new 152
- `src/codegen/object-runtime.ts` (9): ensureObjectRuntime 4234→4725, fillApplyClosure 477→704, fillExternArrayLikeStructArms 310→540, fillClosedStructExternGetArms 317→519, fillDynamicForinVecArms 302→435, fillConcatNativeHoleArms new 310, fillExternSetVecArms new 302, fillExternGetIdxVecArms 159→266, fillClassObjectNameArms new 153
- `src/codegen/array-methods.ts` (9): compileArrayMethodCall 531→723, emitDynViewSpeciesMethodTwoArm new 298, compileArraySplice 191→275, compileArrayReduceRight 221→265, compileTypedArraySet new 192, compileArrayMap new 172, compileArrayReduce new 169, compileArrayToSpliced new 168, compileArrayConcat new 165
- `src/codegen/expressions/calls.ts` (8): compileCallExpression 1811→2305, ensureFuncValueWrappersRegistered new 490, buildInlineDynamicDispatch new 454, compileIIFE 263→315, tryRuntimeEvalInterpretedBoundaryIntrinsic 189→239, emitReflectiveNativeProtoClosureCall new 193, tryEmitNativeProtoReflectiveCall new 192, emitDynamicSpreadCall new 190
- `src/codegen/native-strings.ts` (1): emitExceptionRenderExports new 211

What is still enforced: the required `check:func-budget` gate (#3400) already
blocks any change-set that grows a function over 300 LOC or adds a new one,
so the functions above 300 cannot grow further. The 150–300 LOC band is
unguarded. Options for whoever picks this up: shrink the listed functions
back under their recorded LOC and then wire the gate, or delete
`profile-godfiles.mjs --check` as redundant with `check:func-budget` and keep
the profiler for its report. Either needs a decision, not a baseline refresh.
