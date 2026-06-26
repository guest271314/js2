---
id: 2710
title: "Late-bind module indices (func/global/type) to eliminate the late-index-shift bug class"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: max
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
