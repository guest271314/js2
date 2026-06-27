---
id: 2710
title: "Late-bind module indices (func/global/type) to eliminate the late-index-shift bug class"
status: in-progress
assignee: ttraenkler/sd-indexshift
sprint: current
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: max
owner_role: senior-developer
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1839, 1819, 1851, 1530, 2182]
---
# #2710 — Late-bind module indices to eliminate the index-shift bug class

**Source:** 2026-06-26 codebase audit (tech lead). Recurring "bug factory" #1:
manual function/global/type index shifting. Confirmed instances span the
2026-06-04 fable review (#1839 string-import shift, #1819 logical-assign global
index) and the 2026-06-26 audit (stale global index in static-prop assignment;
optional-direct-call funcIdx not repointed; three drifted shifters).

## Problem — eager index binding

The compiler **binds module indices eagerly**: at instruction-construction time
it bakes `ctx.funcMap.get(name)` (a *live position* in the function index space)
directly into the `Instr` as `funcIdx`. Globals and types do the same. A *live
position* is a value that keeps changing:

- **Late imports** (`addUnionImports`, `addStringImports`, `ensureLateImport`)
  append before defined functions → every defined-function index shifts by +N.
- **String-constant / import globals** insert into the global space → every
  `global.get`/`global.set` index shifts.
- **Dead-code elimination** *removes* type entries → a full type renumber.

Because the concrete index is already baked into thousands of emitted
instructions, every such change must be **chased by hand** into all bodies +
`ctx.currentFunc.body` + `pendingInitBody` + helpers + start func. That sweep is:

1. **Triplicated and drifted** — `shiftLateImportIndices` (late-imports.ts:144),
   plus two hand-rolled shifters in `index.ts` (`addStringImports`,
   `addUnionImports`), plus `flushLateImportShifts` exists in **two** forked
   copies (`shared.ts:376` **and** `late-imports.ts:574`). They have measurably
   diverged (the #2039 flush guard, the asyncScheduler side-channel shift, the
   generic-vs-op-allowlist funcIdx test).
2. **An unwritten invariant applied ad hoc** — the "re-read the index after
   compiling a sub-expression" rule is correct in some arms and forgotten in
   adjacent arms of the *same* function (the `?? funcIdx` repoint hacks). Every
   new emit site is a fresh opportunity to forget it.

The bug class is definitionally: *a concrete index baked into instruction X went
stale when the index space changed.* As long as instructions hold concrete
indices, the class is reachable by construction.

## Preconditions that make this tractable (verified on main 2026-06-26)

1. **One serialization chokepoint** — `src/emit/binary.ts` is the *sole* place a
   `funcIdx`/`globalIdx` becomes bytes (`enc.u32(instr.funcIdx)` at lines
   950/955/1390). Every reference funnels through there.
2. **A relocation/symbol model already exists** — `src/emit/object.ts` builds
   stable symbols + `funcIdxToSymIdx`/`globalIdxToSymIdx` and resolves at emit
   (`encodeInstrWithReloc`). It is only wired to the latent `.o` linker path; the
   machinery is in-repo and proven.
3. **A generic "iterate every index-bearing instruction" pass already exists** —
   `shiftLateImportIndices` (late-imports.ts:160) keys on
   `"funcIdx" in instr && typeof instr.funcIdx === "number"`. That is exactly the
   seam a resolver plugs into.

Scale (construction sites, current main): `op:"call"` ×1892, `op:"ref.func"` ×22,
`global.get/set` ×409; index-bearing fields referenced: `funcIdx` ×3280,
`globalIdx` ×198, `typeIdx` ×5988. Mid-compile *positional reads* of a numeric
module index (the real migration surface): `mod.functions[idx]` ×94,
`mod.globals[idx]` ×55.

## Recommendation — bind indices *last*, not eagerly

Instructions reference functions/globals/types by a **stable handle**: an opaque
id minted at registration that is **never renumbered and never reused**. One
`resolveLayout()` pass runs after all imports/functions/globals/types are
registered and after DCE; it computes the canonical layout (imports-first,
post-DCE) and produces `handle → finalIndex` maps. `binary.ts` dereferences
handle→index as it writes bytes.

**Why this is structurally immune** (not merely better-tested): if no instruction
ever holds a concrete index — only a handle *defined* to be layout-independent —
there is nothing a late import can invalidate. "Late additions don't disturb
emitted code" stops being a discipline every author must remember and becomes
true *by construction*. The reactive sweep disappears because there was never
anything to sweep.

### Minimal-churn form (recommended)

Keep the instruction shape `{op:"call", funcIdx}` and **redefine `funcIdx` to
mean a stable handle**, not a live index. The ~2300 construction sites already
write `ctx.funcMap.get(name)` — make `funcMap` return a stable handle and they
are unchanged. Work concentrates at two seams:

- the ~150 mid-compile positional reads (`mod.functions[idx]`,
  `mod.globals[idx]`) become handle-keyed lookups (some compute
  `idx - numImportFuncs` relative offsets assuming imports-first — those need
  care);
- one `resolveLayout()` + the `binary.ts` dereference.

### Enforcement that makes it a *single safe process*

Brand the handle types:

```ts
type FuncHandle   = number & { readonly __func:   unique symbol };
type GlobalHandle = number & { readonly __global: unique symbol };
type TypeHandle   = number & { readonly __type:   unique symbol };
```

Any code that uses a handle as a raw array index now **fails to typecheck**.
TypeScript mechanically enumerates the migration surface and permanently prevents
reintroducing a positional read. That is the structural guarantee: not "we
remembered to resolve everywhere," but "the typechecker refuses to compile a
concrete-index use."

### Bonus: subsumes the type-DCE renumber factory for free

funcIdx shift is monotonic (+N); type DCE is *remove-and-renumber* — a worse
problem the current shifters don't fully handle (see project memory
`project_type_index_shift_and_deadelim`). Under late binding both are identical:
types get handles, `resolveLayout` emits the live-type ordering after DCE,
instructions referenced handles all along. **One mechanism kills three index-shift
factories** (functions, globals, types — and tags/tables/elems/data come along).

## What gets deleted (payoff)

- `shiftLateImportIndices` (late-imports.ts:144); both `flushLateImportShifts`
  copies (shared.ts:376, late-imports.ts:574); the two hand-rolled shifters in
  `index.ts` (`addStringImports`, `addUnionImports`).
- `localGlobalIdx`, `fixupModuleGlobalIndices`, `shiftMap` over
  `funcMap`/`staticProps`/`funcClosureGlobals` (imports.ts:132/153/277).
- Every `?? funcIdx` "name-based repoint" hack and the `flushLateImportShifts`
  ordering dependencies in `exceptions.ts` / `context/speculative.ts`.
- Makes unreachable: audit findings (static-prop stale global; optional-call
  funcIdx) and #1839 / #1819.

## Migration plan (phased — each step ships green)

1. **Introduce branded handle types**, aliased to `number` — zero runtime change;
   compile errors now flag every positional read. Brand `funcMap`'s value and
   `Instr.funcIdx`/`globalIdx`/`typeIdx`.
2. **Add `resolveLayout()` as an identity map** (handles == current indices) and
   wire `binary.ts` through it. Pure plumbing, behaviour-identical — proves the
   path with zero output diff (assert byte-identical emit on the equivalence
   suite).
3. **Convert the ~150 positional reads** to handle-keyed lookups, typechecker-
   guided. Audit the `idx - numImportFuncs` relative-offset sites specifically.
4. **Mint non-renumbering handles at registration**; `resolveLayout` computes the
   real permutation. Delete the shifters one at a time, each behind a full CI run
   (equivalence + test262 + standalone floor).
5. **Remove** `localGlobalIdx`/`fixupModuleGlobalIndices`/`flush*`/`shift*` and
   the repoint hacks. Class gone.

## Acceptance criteria

- [ ] Branded `FuncHandle`/`GlobalHandle`/`TypeHandle` exist; using a handle as a
      raw array index is a compile error.
- [ ] A single `resolveLayout(mod)` produces `handle → finalIndex` maps; it is the
      only place module indices are assigned, and runs once after registration +
      DCE.
- [ ] `binary.ts` dereferences handles at serialization; no instruction holds a
      concrete module index before that point.
- [ ] `shiftLateImportIndices`, both `flushLateImportShifts`, both hand-rolled
      `index.ts` shifters, `localGlobalIdx`, `fixupModuleGlobalIndices`, and the
      `?? funcIdx` repoints are deleted.
- [ ] No behaviour change: equivalence suite byte-identical (steps 1–2),
      test262 non-regressing, standalone floor green (full CI / merge_group, not
      a scoped sweep — broad-impact change, see project memory).
- [ ] Type-DCE renumber routes through the same `resolveLayout` (one mechanism).

## Notes

- Net performance is *better*: one resolve pass replaces N reactive full-body
  sweeps run today.
- Coordinates with the (done) #1851 legalization boundary; this is the
  index-binding analogue of that seam work.
- Broad-impact, cross-cutting: senior-developer / Opus-tier, max reasoning. Land
  behind the phased plan; never a single mega-PR.

## Implementation Plan

> Grounded against `origin/main` @ `30bc55b2fa01` (2026-06-26 fetch). The PO
> recommendation above is sound; this section pins it to **current** file:line
> anchors (several moved since the issue was drafted), corrects two stale claims,
> and specifies the resolver contract, the exact `binary.ts` dereference seams,
> the byte-identity proof, and the re-introduction guard.

### Root cause (one sentence)

Module indices (`funcIdx` / global `index` / `typeIdx`) are bound **eagerly** at
instruction-construction time, so every late import (`addUnionImports`,
`addStringImports`, `ensureLateImport`→`flushLateImportShifts`), every late
string-constant global (`addStringConstantGlobal`), and DCE's type/func removal
must *chase* the new live positions into thousands of already-emitted instructions
+ ~40 cached side-channel index fields; any emit site that read an index **before**
the chase and reused it **after** emits an off-by-N instruction that only fails in
the merge_group standalone/harness shape (PR-CI host-masked — #2078, #2191/#2193).

### Current shift-site map (verified line anchors on main)

**A. Function-index shifters (4 divergent implementations of one idea):**
1. `shiftLateImportIndices` — `src/codegen/expressions/late-imports.ts:144`. The
   canonical walker. Beyond `mod.functions` bodies it ALSO chases ~9 side-channels:
   `funcMap` (232), `nativeStrHelpers` (245), `nativeRegexHelpers` (256),
   `mapHelpers` (272), `pendingMethodTrampolines.{methodFuncIdx,trampolineFuncIdx}`
   (296), `ctx.asyncScheduler.*FuncIdx` ×15 keys (312-339), exports (341), table
   `elements` (347), `declaredFuncRefs` (357), `startFuncIdx` (369). Every new
   func-index side-channel is a fresh "did you remember to add it here" bug.
2. `reconcileNativeStrFinalizeShift` — `late-imports.ts:469`. A SECOND, independent
   func-index shifter for the native-string finalize regime (gated on
   `nativeStrHelperImportBase >= 0`). Has its own body walker (`shiftBody` 510) and
   its own subset of side-channel chases. Re-base coupling with #1 is delicate
   (see the #1903 / #2039-slice-2 re-base comments at 286 and 606).
3. Hand-rolled inline shifter inside `addStringImports` —
   `src/codegen/index.ts:8254`, shift block `8318`-~8385. Divergent copy: chases
   `funcMap` + exports + bodies + (further down) liveBodies/parentBodies, but does
   **NOT** chase `nativeStrHelpers`/`mapHelpers`/`asyncScheduler`. Safe today only
   because it early-returns under `standalone||wasi` (8262) where those maps live —
   i.e. correctness rests on an unstated mode-coupling invariant.
4. Hand-rolled inline shifter inside `addUnionImports` — `src/codegen/index.ts:9624`
   (analogous body walker).
   `flushLateImportShifts` (late-imports.ts:574) is the batch wrapper around #1.

   **Correction to the issue body:** there are NOT "two forked copies of
   `flushLateImportShifts`". `src/codegen/shared.ts:376` is now a thin registry
   *delegate* (`_flushLateImportShifts`, registered via `registerFlushLateImportShifts`
   at 362) — a single implementation behind an indirection, not a fork. The real
   duplication is the four func-index *shifters* above (#1–#4) plus
   `reconcileNativeStrFinalizeShift`.

**B. Global-index shifter (1, with ~25 cached fields — the #2078 site):**
- `fixupModuleGlobalIndices` — `src/codegen/registry/imports.ts:153`, invoked from
  `addStringConstantGlobal` (imports.ts:122) whenever a string-constant global is
  inserted after module globals exist. Walks `global.get`/`global.set` bodies (187)
  AND chases cached global-index fields: `newTargetGlobalIdx` (164),
  `holeGlobalIdx` (177), maps `moduleGlobals`/`capturedGlobals`/`staticProps`/
  `protoGlobals`/`classObjectGlobals`/`methodClosureGlobals`/`funcClosureGlobals`/
  `tdzGlobals` (284-291), `protoOverrides[*].globalIdx` (302), `staticInitExprs`
  (310), and scalar fields `symbol{Counter,Desc,RegKeys,RegIds,RegCount}GlobalIdx`,
  `wasiBumpPtrGlobalIdx`, `argcGlobalIdx`, `extrasArgvGlobalIdx`,
  **`currentThisGlobalIdx` (340)**. The last one is exactly #2078: a producer cached
  `currentThisGlobalIdx` before a `buildDispatch` late string-constant import and
  re-used it after the +1 shift → `global.set expected f64 found externref`.
- `localGlobalIdx(ctx, absIdx) = absIdx - ctx.numImportGlobals` (imports.ts:132) and
  `nextModuleGlobalIdx = numImportGlobals + mod.globals.length` (127) are the
  imports-first *relative-offset* readers — the analogue of the func
  `idx - numImportFuncs` sites the migration must convert carefully.

**C. Type-index renumber (remove-and-renumber — the harder factory):**
- `eliminateDeadImports` — `src/codegen/dead-elimination.ts:274`, called once from
  `index.ts:1901` / `index.ts:5768`. Collects live funcs+types
  (`collectRefsFromBody` 19), removes dead, and remaps ALL survivors via
  `remapFuncIdxInBody` (150) / `remapTypeIdxInBody` (162) with the #1302/#2564
  shared-array double-remap guards. This is the `project_type_index_shift_and_deadelim`
  factory: funcIdx shift is monotonic +N, but type-DCE is arbitrary
  remove-and-renumber, which the A/B shifters do not even attempt.

**D. The single serialization chokepoint (the resolve seam):**
- `src/emit/binary.ts` `emitBinary` (255) → `encodeInstr`. Concrete index → bytes
  happens at exactly: `funcIdx` lines **950** (`call`) and **955** (`return_call`/
  `ref.func`); global `index` lines **990** (`global.get`) / **995** (`global.set`);
  `typeIdx` at 332/380/638/727/732/765/800/893/963/1255/1279/… plus export
  descriptors (833), table elements, and `startFuncIdx`. A `vIdx(...)` bounds-check
  already precedes each (948/988/…) — keep it; it is the runtime backstop.

**E. Proven relocation precedent (reuse, don't reinvent):**
- `src/emit/object.ts` already builds stable symbols + `funcIdxToSymIdx` (70) /
  `globalIdxToSymIdx` (72) and dereferences at emit (`encodeInstrWithReloc` 399).
  Wired only to the latent `.o` linker path, but it is the exact "resolve a stable
  id to a final index at serialization" shape `resolveLayout` generalizes.

**Finalize ordering (where `resolveLayout` slots in), `index.ts` generateModule:**
`…compile bodies → ensureDynReadHelpers (1896, last import add) → markLeafStructsFinal
(1898) → eliminateDeadImports (1901) → repairStructTypeMismatches (1904) →
peepholeOptimize (1907) → indexSpaceFrozen=true (1915) → stackBalance (1918) →
fixupExternConvertAny (1924) → [caller] emitBinary`. `resolveLayout` runs **at the
freeze point (1915)**, after all registration + DCE, before emit. The
multi-module path mirrors this at `index.ts:5768`/`5780`.

### Mechanism — late-bind via stable handles + one `resolveLayout`

Adopt the issue's **minimal-churn** form: keep the instruction shape
(`{op:"call", funcIdx}`, `{op:"global.get", index}`, `…typeIdx`) and **redefine the
field to carry a stable handle**, not a live index. A handle is an opaque id minted
at registration from a per-kind monotonic counter (`ctx.nextFuncHandle++` /
`nextGlobalHandle` / `nextTypeHandle`), **never renumbered, never reused**. The
~2300 construction sites already do `funcMap.get(name)` / `moduleGlobals.get(name)`
/ `addFuncType(...)` — make those registries *return handles* and the sites are
unchanged. One `resolveLayout(ctx, mod)` computes `handle → finalIndex` once;
`binary.ts` dereferences at the 14 encode seams in (D).

**Brand the handle types** (`src/ir/types.ts`, alongside the `Instr` union):
```ts
export type FuncHandle   = number & { readonly __func:   unique symbol };
export type GlobalHandle = number & { readonly __global: unique symbol };
export type TypeHandle   = number & { readonly __type:   unique symbol };
```
Apply per **union arm** (TS allows distinct field types per discriminated member —
this is what disambiguates the shared `index` field):
- `{op:"call"; funcIdx: FuncHandle}`, `{op:"return_call"; funcIdx: FuncHandle}`,
  `{op:"ref.func"; funcIdx: FuncHandle}`.
- `{op:"global.get"; index: GlobalHandle}`, `{op:"global.set"; index: GlobalHandle}`
  — **leave `local.{get,set,tee}` `index: number` untouched**: locals are
  function-scoped, never shift, and must NOT be branded (binary.ts already
  discriminates on `op`, so the global arms dereference, the local arms pass
  through).
- every `typeIdx: number` on type-bearing arms → `typeIdx: TypeHandle`
  (struct/array/ref/cast/test/call_indirect/call_ref/block-type/`Import.desc.typeIdx`
  /`TagDef.typeIdx`/`FieldDef`); `dstTypeIdx`/`srcTypeIdx` too.
- `funcMap: Map<string, FuncHandle>`, the helper maps
  (`nativeStrHelpers`/`nativeRegexHelpers`/`mapHelpers`), `stringGlobalMap`/
  `moduleGlobals`/… values, and the ~40 cached scalar fields → their branded type.

**Why structurally immune:** if no instruction or side-channel ever holds a
concrete index — only a layout-independent handle — there is nothing a late import
can invalidate. Using a handle as a raw array index (`mod.functions[h]`,
`h - numImportFuncs`, `h + delta`) becomes a **compile error**, so TS mechanically
enumerates the migration surface and permanently forbids reintroducing the bug.

**`resolveLayout(ctx, mod): ModuleLayout` contract** (new file
`src/emit/resolve-layout.ts`):
- Input: the registered handle→def registries + liveness. Reuse
  `collectRefsFromBody` from dead-elimination to compute the live handle set.
- Output: `{ func(h: FuncHandle): number; global(h: GlobalHandle): number;
  type(h: TypeHandle): number; numFuncs/numGlobals/numTypes }` backed by dense
  `Map<handle, finalIndex>`.
- Canonical ordering — **must reproduce the current final layout byte-for-byte**
  (this is what makes the whole migration byte-identical, see proof below):
  - funcs: imports in import-declaration order first, then live defined funcs in
    `mod.functions` array order (post-DCE), exactly as `eliminateDeadImports`
    leaves them today.
  - globals: import globals first (import order), then `mod.globals` array order.
  - types: post-DCE live order preserving original relative order +
    rec-group boundaries (mirror `dead-elimination`'s type remap + binary.ts:288
    rec-group computation).
- `resolveLayout` is the **sole** place a module index is assigned. It SUBSUMES
  `eliminateDeadImports`'s renumber (DCE keeps liveness analysis + section removal,
  but stops *renumbering instructions* — it just drops dead defs; the layout skips
  dead handles).

**Tradeoffs vs. alternatives (evaluated, rejected as primary):**
- *Single authoritative post-shift fixup* (keep eager indices, run one final
  re-derive): simpler, but an index is still concrete between registration and
  fixup — any read in that window is still stale. No structural immunity. Reject.
- *Reserve index ranges up-front* (pad N import slots): fragile (must guess N,
  wastes slots) and does nothing for type-DCE *removal*. Reject.
- Handles win because **one mechanism kills all three factories** (func shift,
  global shift, type remove-and-renumber) and the brand makes regression a compile
  error, not a discipline.

### Migration slices (each ships green; each byte-identity-provable)

**Slice 0 — proof harness first (no behavior change).** Add
`scripts/prove-emit-identity.mjs`: compile a fixed corpus
(`playground/examples/**/*.ts` + the `tests/equivalence` sources) across the
target matrix `{gc(default), --target standalone, --target wasi}`, and emit
`sha256(emitBinary(mod))` per `(file,target)` into a JSON baseline. Run on
`origin/main` to capture the golden hashes. This is the regression oracle for
slices 1–4.

**Slice 1 — branded handle types as pure aliases.** Define the three brands;
re-type the `Instr` arms + `funcMap`/helper-map/global-map values + the ~40 cached
scalar fields. Zero runtime change (brands erase to `number`). Add ONE audited
escape `unsafeHandleAsIndex(h): number` in `resolve-layout.ts` for the not-yet-
converted positional reads, so the tree still typechecks. `tsc --noEmit` now
enumerates every positional read as the migration surface. **Prove:**
`prove-emit-identity` hashes unchanged (brands are erased).

**Slice 2 — `resolveLayout` as identity + wire `binary.ts`.** Add `resolveLayout`
returning identity maps (handle == current index). Thread a `ModuleLayout` into
`emitBinary`/`encodeInstr` and dereference at the 14 seams in (D)
(`enc.u32(layout.func(instr.funcIdx))` etc.). Pure plumbing. **Prove:**
`prove-emit-identity` hashes **byte-identical** (acceptance criterion "byte-identical
steps 1–2").

**Slice 3 — convert positional reads to handle-keyed lookups.** Typechecker-guided
(remove `unsafeHandleAsIndex` call by call). Special-attention list (the
imports-first relative-offset readers): `localGlobalIdx`/`nextModuleGlobalIdx`
(imports.ts:127/132), `mod.functions[idx]`/`mod.globals[idx]` positional reads
(~94 + ~55 per the issue audit), and any `idx - numImportFuncs` arithmetic. Each
becomes `layout`/registry-keyed. Handles are still identity here, so **prove:**
byte-identical again.

**Slice 4 — mint non-renumbering handles + real permutation; delete shifters one
at a time.** Switch counters to mint stable registration-order handles;
`resolveLayout` computes the real live permutation reproducing today's final order.
Then delete, each behind a FULL CI run (equivalence + test262 + standalone floor /
merge_group — broad-impact, never a scoped sweep, per project memory
`project_broad_impact_validate_full_ci`):
  - 4a: `fixupModuleGlobalIndices` + the ~25 cached global-idx chases
    (registry/imports.ts) — self-contained, and it is the #2078 site, so land first.
  - 4b: `shiftLateImportIndices` + `flushLateImportShifts` (late-imports.ts) and the
    hand-rolled `addStringImports`/`addUnionImports` inline shifters (index.ts).
  - 4c: `reconcileNativeStrFinalizeShift` + `nativeStrHelperImportBase` re-base
    machinery.
  - 4d: route type-DCE through `resolveLayout` — `eliminateDeadImports` stops
    renumbering instructions (drops dead defs only).
  Because `resolveLayout` reproduces the current final order, **prove:**
  `prove-emit-identity` stays byte-identical through 4a–4d (strongest possible proof
  — the migration changes representation, not output).

**Slice 5 — delete dead machinery + repoint hacks.** Remove `localGlobalIdx`/
`nextModuleGlobalIdx` relative-offset helpers if fully subsumed, every `?? funcIdx`
name-based repoint, the `flushLateImportShifts` ordering deps in `exceptions.ts` /
`context/speculative.ts`, and `unsafeHandleAsIndex`. The bug class is now
unreachable by construction.

### Proving no regression

1. **Primary (slices 1–4): byte-identity** via `scripts/prove-emit-identity.mjs`.
   Reproducing the current final layout makes EVERY slice byte-identical, so any
   drift is a single sha mismatch pinpointing the offending `(file,target)` — far
   stronger than test262 row counts.
2. **Secondary (slice 4d type-DCE, where reproduction risk is highest):** if a
   target legitimately cannot be made byte-identical, fall back to the
   regressed-rows oracle — run test262 on main vs branch, require
   **regressed rows flip back to pass and zero net new failures**, AND all
   previously-valid modules still pass the in-emit `vIdx` validator (binary.ts) +
   `wasm-validate`.
3. **Floor:** standalone floor + full merge_group (NOT scoped) on every shifter
   deletion — this bug class is merge_group-only by nature
   (`reference_single_pr_merge_group_refail_is_real_not_drift`).

### Guard / test strategy (fails on a re-introduced cached-index bug)

1. **The brand is the structural guard.** `tsc --noEmit` (already in the `quality`
   gate) rejects any `mod.functions[handle]` / `handle - numImportFuncs` /
   `handle + delta`. Document that the brand may be widened to `number` ONLY inside
   `resolve-layout.ts` (and the single `unsafeHandleAsIndex` chokepoint, deleted in
   slice 5).
2. **Lint backstop** `scripts/check-no-eager-index.mjs` (wire into `quality`):
   fail on any new `+= added`/`+= delta` over a `funcIdx`/`index`/`typeIdx`, any new
   `function shift*Indices`, or `mod.{functions,globals}[` indexed by a non-`layout`
   expression outside the resolver. Catches a regression even if someone casts past
   the brand.
3. **Reproduction unit test** `tests/issue-2710-late-bind.test.ts`: build a module,
   emit a `call`/`global.get`/`global.set` referencing a handle, THEN add a late
   import (func) and a late string-constant global (`addStringConstantGlobal`),
   run `resolveLayout` + `emitBinary`, and assert the emitted indices are correct +
   the module validates. Encodes #2078 (cached `currentThisGlobalIdx` across a late
   string-constant import) and #2191/#2193 (late funcIdx shift) as permanent
   regression tests — they must fail on `origin/main`'s eager binding if the brand
   is reverted.
4. Keep binary.ts `vIdx` bounds-checks as the emit-time runtime backstop for any
   handle that fails to resolve.

### What gets deleted (payoff — grounded anchors)

- `shiftLateImportIndices` + `flushLateImportShifts` (late-imports.ts:144/574),
  `reconcileNativeStrFinalizeShift` (late-imports.ts:469) + `nativeStrHelperImportBase`.
- The two hand-rolled inline shifters in `index.ts` (`addStringImports` 8254 shift
  block, `addUnionImports` 9624 shift block).
- `fixupModuleGlobalIndices` (registry/imports.ts:153) + its ~25 cached-field chases,
  and the eager renumber inside `eliminateDeadImports` (dead-elimination.ts).
- `localGlobalIdx`/`nextModuleGlobalIdx` relative-offset helpers (if fully subsumed),
  every `?? funcIdx` repoint hack, and the `flushLateImportShifts` ordering deps.
- Makes unreachable: #2078, #2191/#2193, #1839, #1819, and the recurring
  `project_type_index_shift_and_deadelim` factory.

## Progress log

### Slices 0 + 1 — foundation landed (sd-indexshift, 2026-06-26)

**Scope of this PR:** the *safe foundation* only — slice 0 (proof harness) and
slice 1 (handle vocabulary as transparent aliases). It does **not** add
`resolveLayout`, wire `binary.ts`, convert positional reads, mint
non-renumbering handles, or delete any shifter. The umbrella issue therefore
stays `in-progress`; slices 2–5 are follow-up tasks.

**Slice 0 — `scripts/prove-emit-identity.mjs`.** A sha256 byte-identity oracle:
compiles the `website/playground/examples` corpus across the `{gc, standalone,
wasi}` target matrix and records `sha256(emitBinary(mod))` per `(file,target)`.
`write` mode captures a golden baseline; `check` mode fails (exit 1) on any
single drift, pinpointing the exact `(file,target)`. The baseline is a hash of
raw emitted bytes — it legitimately changes on most unrelated PRs — so it is
written to gitignored `.tmp/` and is **never committed**; this is a developer
proof tool, not a CI gate. It is the regression oracle for every later slice
(reproducing the current final layout makes each slice byte-identical, so any
representation bug shows up as a single sha mismatch — far sharper than test262
row counts).

**Slice 1 — branded handle types as pure aliases (`src/ir/types.ts`).** Defined
`FuncHandle` / `GlobalHandle` / `TypeHandle` and pinned them onto the correct,
*discriminated* `Instr` arms + type defs:
- `funcIdx: FuncHandle` on `call` / `return_call` / `ref.func`; func-index
  side-channels in this file (`WasmModule.startFuncIdx`, `declaredFuncRefs`,
  `Element.funcIndices`).
- `index: GlobalHandle` on **`global.{get,set}` only** — `local.{get,set,tee}`
  share the `index` field name but are function-scoped and never shift, so they
  stay raw `number`. This per-union-member field typing is the load-bearing
  discrimination: `binary.ts` already switches on `op` at the encode seams, so
  the global arms can later dereference a handle while the local arms pass
  through unchanged.
- `typeIdx: TypeHandle` on every type-bearing arm (`struct.*`, `array.*` incl.
  `array.copy` `dst/srcTypeIdx`, `ref.cast{,_null}`, `ref.test`, `ref.null`,
  `call_indirect`, `call_ref`, `return_call_ref`), plus `ValType.ref/ref_null`,
  `BlockType{kind:"type"}`, `WasmFunction.typeIdx`, `StructTypeDef.superTypeIdx`,
  `SubTypeDef.superType`, `TagDef.typeIdx`, `ImportDesc.func/tag.typeIdx`.
- Left as raw `number` (separate index spaces, never the three handle kinds):
  `tableIdx`, `fieldIdx`, `tagIdx`, and `WasmExport.desc.index` (polymorphic
  func/table/memory/global/tag).

**Why aliases, not the real `unique symbol` brand, in this slice.** The brand's
*enforcement* (turning `mod.functions[h]` / `h - numImportFuncs` / `h + delta`
into compile errors) only becomes safe AFTER the ~150 positional reads are
converted (slices 3–4) and registration sites mint handles. Flipping the brand
now would leave the tree red. So slice 1 ships the alias form: zero runtime
change, fully interchangeable with `number`, `tsc`-clean, and **byte-identical**
(brands erase). The future flip to
`number & { readonly __func: unique symbol }` is a one-line change per type in
`src/ir/types.ts` — the vocabulary and the correct arm placement are already in
place, so that later slice only has to chase the errors `tsc` then surfaces.

**Proof:** `tsc --noEmit` clean; `prove-emit-identity.mjs check` reports
`IDENTICAL — all 39 (file,target) emits match baseline` (gc + standalone + wasi).
Files touched: `scripts/prove-emit-identity.mjs` (new), `src/ir/types.ts`
(typing only).
