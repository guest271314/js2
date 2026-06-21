---
id: 1899
title: "finalize funcIdx-authority contract: reconcile↔dead-elim native-string helper sibling-call mismatch (late-shift class recurrence-proofing)"
status: done
assignee: senior-dev
updated: 2026-06-21
completed: 2026-06-21
sprint: 65
created: 2026-06-05
priority: medium
feasibility: hard
task_type: refactor
area: codegen
goal: standalone-mode
related: [329, 1677, 1809, 1839, 1886, 1891, 1257, 1888, 1209]
---
# #1899 — finalize funcIdx-authority contract (recurring late-shift class kill)

**Architect input from sd-1472c's #329 trace. The architect ratifies the
finalize funcIdx-authority contract; a senior-dev then implements (B) off it.
Do NOT blind-implement — high blast radius (35 bake sites, every standalone/WASI
string program). One careful change, not a guess.**

## The recurring class (5th occurrence)
A defined-function `call <funcIdx>` baked **mid-finalize** goes stale when
finalize-time imports are added (and/or later removed), because the index space
shifts under the already-baked call. Prior occurrences: #1677, #1809, #1839,
#1886, #1891 (and the @@toPrimitive/#118 trigger), now #329. Each was patched
point-wise; this issue ratifies the *contract* so it stops recurring.

## Keystone (why it's worth a contract, not another point-fix)
The SAME reconcile↔dead-elim funcIdx mismatch blocks three in-flight workstreams:
- **#329** — `__str_flatten`→`__str_copy_tree` (native-string sibling call).
- **#1888 S2** — `__apply_closure` baked calls into `__call_fn_method_N`.
- **#1888 Slice 5 (live)** — accessor `__call_fn_method_N` baked calls.
Fix the authority once → unblocks all three.

## Trace / evidence (sd-1472c, --target standalone, instrumented)
Repro: `let g: any; g = function () { return 42; }; export function test(): number { return g(); }`
fails validation: `__str_flatten ... call[0] expected (ref null 5), found i32.const`.
(`const f:any=fn` / `let f:any=fn` initializer forms are already valid.)

`reconcileNativeStrFinalizeShift` (late-imports.ts:355) firings
`(base, numImportFuncs, added)`:
- INIT (valid):   `(0,1,+1)`, `(1,1,0)`
- ASSIGN (broken): `(0,1,+1)`, `(1,1,0)`, **`(1,2,+1)`** ← extra

The extra 3rd firing is triggered by `env::__get_undefined` (the `let g`
undefined-init host import) landing at import idx 1 AFTER the native-string
helpers were emitted mid-finalize.

## Why the current design mis-handles it
- `reconcileNativeStrFinalizeShift` runs **incrementally** and **re-bases**
  `nativeStrHelperImportBase = numImportFuncs` each call, shifting helper-map
  entries + helper-body sibling-calls UP by the per-call delta. It assumes
  imports are **monotonic** (only added).
- It is called at 5 points (index.ts:1050/1111/4308/4336/7886) **interleaved
  with body compilation** — bodies emitted between calls bake `call <helper>`
  reading the CURRENT (already-shifted) helper index. So the incremental shift
  is **load-bearing**: a single end-of-finalize shift would break every body
  emitted before the final import settles. (Option A is therefore NOT a small
  change — see below.)
- `eliminateDeadImports` (dead-elimination.ts:221, called index.ts:1504/4496)
  can later **REMOVE** a now-dead finalize import and remap all call targets —
  the add-then-remove churn the incremental monotonic reconcile cannot model.
  The cumulative incremental deltas then disagree with the FINAL import count →
  the baked sibling call is off-by-one.

## Options
- **(A) compute the shift ONCE from FINAL numImportFuncs vs original base.**
  Net-zero for the monotonic case, correct for churn — BUT it fights the
  load-bearing mid-stream incremental requirement (bodies emitted before the
  final count need correct indices at their emit time). Not feasible as a small
  change without restructuring when bodies are emitted vs when imports settle.
- **(B) RECOMMENDED — post-dead-elim by-name re-resolution as the authority.**
  After ALL finalize import churn (the last reconcile AND `eliminateDeadImports`)
  settles, run one final pass that re-points every finalize-emitted helper body's
  sibling-helper `call` to the authoritative `nativeStrHelpers.get(<name>)`
  (and `funcMap.get(<name>)` for the broader set). Requires anchoring each
  sibling call to a NAME, since `{op:"call",funcIdx}` carries no name today.
  Two sub-approaches for the contract to choose:
  - (B1) tag each helper sibling-call with `helperName` at the ~35 emit sites
    (flatten→copyTree, slice→substring, includes→indexOf, trim→isWhitespace+
    substring, padStart→concat+repeat+substring, repeat→concat, …), then the
    final pass re-points by tag. Most explicit; touches 35 sites.
  - (B2) build a stale-index→name reverse map snapshotted at each helper
    registration, and re-point in the final pass. No emit-site changes; one
    central map. Prefer if the contract finds it sound.

## Contract questions for the architect
1. Who OWNS finalize-emitted helper call-target resolution — reconcile (shift),
   dead-elim (remap), or a final by-name authority pass? (Recommend: a final
   by-name pass is the single source of truth; reconcile/dead-elim become
   index-bookkeeping that the final pass overrides for helper sibling-calls.)
2. Scope: native-string helpers only, or all finalize-emitted defined funcs
   (so it also covers `__call_fn_method_N` for #1888 S2 + Slice 5)?
3. B1 (tag at emit) vs B2 (central reverse map) — ratify one.
4. Interaction with `flushLateImportShifts` (compilation-phase path) — confirm
   the final pass doesn't double-shift compilation-phase baked calls.

## Already landed (independent, keep)
PR #1225 (#329 targeted fix): under `ctx.nativeStrings`, `ensureGetUndefined`
returns undefined → callers use the native `ref.null.extern` sentinel instead of
the `env::__get_undefined` host import. Removes THIS trigger + fixes a real
standalone/wasi host-import leak. Regression test:
`tests/issue-329-assign-closure-lateshift.test.ts`. #1899 is the durable
class-level kill on top; #1225 does not block it.

## Net / detection
#1209's `validateFuncRefs` (src/emit/binary.ts, env-gated) only catches
OUT-OF-RANGE/-1 funcIdx, NOT this IN-RANGE-but-wrong-target case. The #1899 fix
is the real prevention; consider extending the guard to flag helper sibling-calls
whose target name≠expected once the by-name authority exists.

## Resilience
Full context also in `plan/agent-context/sd-1472c-329.md`.

---

## Ratification (arch1, 2026-06-16 — against upstream/main 319d43460)

### Live-repro check: NO LIVE REPRO post-#1225
I compiled the exact #1899 repro and three sibling forms in `--target standalone`
on current main and **all compile AND validate cleanly**:

| Case | Result |
|---|---|
| `let g:any; g = function(){return 42;}; export function test(){ return g(); }` (the #1899 repro) | compile-ok, **VALIDATE OK** |
| `const f:any = function(){return 1;}; …` | compile-ok, VALIDATE OK |
| closure-assign + native-string `.slice` in the same fn | compile-ok, VALIDATE OK |
| native-string-helper-heavy (`+`, `.slice`, `.repeat`) | compile-ok, VALIDATE OK |

The `__str_flatten ... call[0] expected (ref null 5), found i32.const` validation
failure the issue documents **no longer reproduces**. PR #1225's
`ensureGetUndefined` fix (under `ctx.nativeStrings`, return the native
`ref.null.extern` sentinel instead of importing `env::__get_undefined`) removed
the *specific* late finalize-import that triggered the extra 3rd
`reconcileNativeStrFinalizeShift` firing. With that trigger gone, the
incremental-monotonic reconcile no longer disagrees with the final import count
for the cited repro.

### Contract questions — ratified answers

**Q1 — Who OWNS finalize-emitted helper call-target resolution?**
RATIFIED: a **final, post-all-churn, by-name authority pass** is the single
source of truth. `reconcileNativeStrFinalizeShift` (incremental shift) and
`eliminateDeadImports` (remap) remain index-bookkeeping, but for *finalize-emitted
helper sibling-calls* the final pass overrides them by re-pointing each such
`call` to `nativeStrHelpers.get(<name>)` / `funcMap.get(<name>)`. Rationale: the
recurring class is precisely that two independent bookkeeping mechanisms
(incremental add vs. churn-aware remove) cannot agree on an index; a single
name-anchored authority that runs *after both settle* is the only design that
cannot drift. Option (A) (compute-shift-once) is correctly rejected in the issue
— it fights the load-bearing mid-stream incremental requirement.

**Q2 — Scope: native-string helpers only, or all finalize-emitted defined funcs?**
RATIFIED: **all finalize-emitted defined funcs**, not just native-string helpers.
The same class blocks #1888 S2 (`__apply_closure`→`__call_fn_method_N`) and
#1888 Slice 5 (accessor `__call_fn_method_N`). A native-string-only authority
would leave those two to recur. The final pass keys off a registry of
`(emittedFuncName → funcIdx)` covering every finalize-time-defined helper, so one
mechanism kills all three workstreams' exposure.

**Q3 — B1 (tag at emit) vs B2 (central reverse map)?**
RATIFIED: **B2 — central reverse map**, snapshotted at each helper registration.
B1 touches ~35 emit sites (high diff surface, easy to miss a site, and each new
helper must remember to tag — the same forgot-a-site failure mode that produced
5 recurrences). B2 is one central map maintained where helpers are *registered*
(a single chokepoint), so a newly-added helper is covered automatically with no
per-emit-site discipline. The reverse map is `Map<staleFuncIdxAtBake, helperName>`
populated when a helper sibling-call is baked; the final pass walks every
finalize-emitted body and, for each `{op:"call", funcIdx}` whose `funcIdx` is in
the reverse map, re-points it to the authoritative current index for that name.
(Edge: a helper may be baked at several stale indices over the run — the map
value is the *name*, which is stable, so collisions resolve correctly.)

**Q4 — Interaction with `flushLateImportShifts` (compilation-phase path)?**
RATIFIED constraint: the final by-name pass must operate **only on
finalize-emitted helper bodies** (the native-string helpers + the enumerated
finalize-time defined funcs), identified by membership in the central registry —
NOT on compilation-phase bodies that `flushLateImportShifts` already correctly
shifted. Double-shifting is avoided because the final pass *overwrites by name*
(idempotent: re-pointing an already-correct call to the same authoritative index
is a no-op) rather than applying a delta. The implementer must assert the final
pass never touches a `call` whose funcIdx is not in the reverse map, so
compilation-phase calls are untouched even if they happen to alias a stale index
numerically.

### Disposition: RATIFIED design, recommend **defer (not wont-fix), de-prioritise**

- There is **no live failing repro** on current main, so this is **not
  dispatchable as a bugfix right now** — a senior-dev implementing (B2) would be
  refactoring against a class with no reproducing case, which violates the s63
  "verify-still-repros-then-fix" discipline and risks a high-blast-radius (35
  bake sites / every standalone string program) change with no failing test to
  anchor correctness.
- **Recommend: keep at `status: ready` but DROP from the s63 dispatch queue.**
  Re-activate (and dispatch (B2) to a senior-dev) the moment EITHER:
  (a) #1888 S2 or Slice 5 surfaces a concrete `expected (ref null N), found
  i32.const`-class validation failure during their own implementation (the
  issue's keystone claim — those are the live consumers), OR
  (b) any new finalize-import addition re-triggers the reconcile/dead-elim
  mismatch with a reproducing case.
- When re-activated, the implementer has a fully-ratified blueprint above:
  final by-name authority pass (Q1), all-finalize-funcs scope (Q2), central
  reverse map B2 (Q3), registry-membership-gated to avoid double-shift (Q4).
- **Detection hardening (cheap, dispatchable now if desired):** extend #1209's
  `validateFuncRefs` (`src/emit/binary.ts`, env-gated) to flag a finalize-emitted
  helper sibling-`call` whose target *name* ≠ the expected helper name, once a
  name-anchored registry exists. This converts the silent in-range-wrong-target
  failure into a loud one and is the lowest-cost first step — but it presupposes
  the B2 reverse map, so it lands *with* (B2), not before.

This satisfies the task directive: 4 questions resolved, no live repro confirmed,
disposition = defer-with-ratified-blueprint (not wont-fix — the class can recur
via #1888; the design is locked in so the next occurrence is a mechanical
implementation, not a re-investigation).

---

## Implementation Plan (arch, 2026-06-21 — against upstream/main 0e482f2fc)

Implements the ratified design above: a **final, post-all-churn, by-name
authority pass** (Q1) over **all finalize-emitted defined funcs** (Q2), driven
by a **central reverse map B2** (Q3), **registry-membership-gated** so it never
touches compilation-phase calls (Q4). This is a senior-dev task: high blast
radius (every standalone/WASI string program flows through these helpers).
**Do not dispatch as a live bugfix** — there is no reproducing case on current
main (PR #1225 removed the cited trigger). Activate only under one of the
re-activation triggers above. When activated, follow this plan exactly.

### Root cause (confirmed in source, upstream/main 0e482f2fc)

Two independent index-bookkeeping mechanisms cannot agree on a final funcIdx
for a finalize-emitted helper's baked **sibling `call`**:

1. **`reconcileNativeStrFinalizeShift`** (`src/codegen/expressions/late-imports.ts:429`)
   is **incremental and monotonic**. Each call computes
   `added = ctx.numImportFuncs − ctx.nativeStrHelperImportBase`, shifts every
   `call`/`return_call`/`ref.func` with `funcIdx >= base` up by `added` across
   ALL `ctx.mod.functions` bodies, then **re-bases** `nativeStrHelperImportBase =
   numImportFuncs` (line 438). It is invoked at **6 interleaved sites**
   (`index.ts:1189, 1250, 5314, 5342, 9310` + the `flushLateImportShifts`
   re-base partner). The interleaving is **load-bearing**: helper bodies emitted
   between two reconcile calls bake `nativeStrHelpers.get(<sibling>)!` at the
   *current* (already-shifted) index, so a single end-of-finalize shift would
   be wrong for them — this is exactly why Option (A) is rejected.

2. **`eliminateDeadImports(mod)`** (`src/codegen/dead-elimination.ts:254`,
   called at `index.ts:1794, 5522`) can **REMOVE** a now-dead finalize import
   and remap every call target down (`fR` remap, lines 339–347 / 390–392). It
   mutates **`mod` only** — it never updates `ctx.nativeStrHelpers`,
   `ctx.funcMap`, or `ctx.nativeRegexHelpers`. After dead-elim those side-tables
   are stale by the removed-import delta. (Confirmed: the function signature is
   `eliminateDeadImports(mod: WasmModule)` and its body touches no ctx field.)

The add-then-remove churn (reconcile adds, dead-elim removes) is what the
incremental monotonic reconcile cannot model: cumulative `+added` deltas
disagree with the FINAL import count, so a baked sibling `call` is off-by-N.
`validateFuncRefs` (`src/emit/binary.ts`, always-on since #2043) only catches
**out-of-range / -1**, never this **in-range-but-wrong-target** case (the
`call[0] expected (ref null N), found i32.const` flavor).

### The authority pass — design

Add **one** final pass, `repointFinalizeHelperSiblingCalls(ctx)`, that runs
**after the LAST reconcile AND after `eliminateDeadImports`** but **before
`ctx.indexSpaceFrozen = true`**. It re-points every finalize-emitted helper
body's sibling `call`/`return_call`/`ref.func` to the authoritative current
index for that target's **name**. Because it overwrites *by name* (idempotent:
re-pointing an already-correct call to the same index is a no-op) rather than
applying a delta, it cannot double-shift.

**The authoritative name→index map after all churn.** There is no single
post-dead-elim name→index table today, because `eliminateDeadImports` does not
update the ctx maps. The pass must build the authority from `mod` itself, which
IS post-dead-elim-correct:

```
authorityByName: Map<string, number>
  for i in 0..mod.functions.length:
    name = mod.functions[i].name
    if name: authorityByName.set(name, numImportFuncs_after_deadElim + i)
```

`numImportFuncs_after_deadElim = mod.imports.filter(d.kind==="func").length`
(recompute from `mod`, do NOT trust `ctx.numImportFuncs`, which dead-elim also
left stale). Every finalize-emitted helper is a **named defined function**
(`__str_flatten`, `__str_copy_tree`, `__call_fn_method_N`, `__apply_closure`,
…), so it is present in `authorityByName` by construction.

### The central reverse map (B2) — `ctx.finalizeHelperCallSites`

The problem with re-pointing is identifying **which** baked `{op:"call",
funcIdx}` immediates are finalize-helper sibling calls (vs. ordinary
compilation-phase calls that happen to alias the same numeric index). B2 solves
this with a **central reverse map populated at helper-registration time**, the
single chokepoint, so no per-emit-site discipline is needed (the failure mode
that produced 5 recurrences).

**New ctx field** (`src/codegen/context/types.ts`, near `nativeStrHelpers`):

```ts
/**
 * #1899 — central reverse map for the finalize-helper by-name authority pass.
 * Maps every funcIdx value at which a finalize-emitted helper was REGISTERED
 * (i.e. the value a sibling `call` may have baked) → the helper's stable NAME.
 * A helper may register/observe several stale indices over a run; the value is
 * the name (stable), so collisions resolve to the correct name. Consumed once
 * by `repointFinalizeHelperSiblingCalls` after all index churn settles.
 */
finalizeHelperStaleIdxToName: Map<number, string>;
```

Initialize to `new Map()` in `create-context.ts` alongside `nativeStrHelpers`.

**Populate at every helper registration.** Wherever a finalize-emitted helper
is registered today — `ctx.nativeStrHelpers.set(<name>, funcIdx)` (≈40 sites in
`native-strings.ts` + the helpers in `binary-ops.ts`, `string-ops.ts`,
`array-methods.ts`, `object-runtime.ts` `__apply_closure`/`__call_fn_method_N`,
`json-*`, `case-convert-native.ts`, `uri-encoding-native.ts`,
`parse-number-native.ts`, `symbol-native.ts`, `map-runtime.ts`,
`date-parse-native.ts`, `native-regex.ts`/`regexp-standalone.ts`) — also record
the reverse entry. **Do this via a single helper, not 40 inline edits**, to
keep the chokepoint property:

```ts
// src/codegen/native-strings.ts (or a new small module imported widely)
export function registerFinalizeHelper(
  ctx: CodegenContext, name: string, funcIdx: number,
  map: Map<string, number> = ctx.nativeStrHelpers,
): void {
  map.set(name, funcIdx);
  ctx.finalizeHelperStaleIdxToName.set(funcIdx, name);
}
```

Then mechanically replace `ctx.nativeStrHelpers.set(name, funcIdx)` →
`registerFinalizeHelper(ctx, name, funcIdx)` and
`ctx.funcMap.set("__apply_closure", funcIdx)` /
`ctx.funcMap.set("__call_fn_method_N", funcIdx)` →
`registerFinalizeHelper(ctx, name, funcIdx, ctx.funcMap)` at the registration
sites. **Critical subtlety — the reverse map must also follow shifts.** Every
shift pass that re-bases `nativeStrHelpers` entries
(`reconcileNativeStrFinalizeShift` lines 510–512, the `flushLateImportShifts`
re-base at `index.ts:7766–7773 / 9215–9226`, `shiftLateImportIndices`) must
ALSO add the post-shift index to `finalizeHelperStaleIdxToName` (it is additive
— keep old stale entries too, since bodies emitted before the shift baked the
old value and bodies after baked the new one; both must map to the name). The
cleanest implementation: in each of those passes, after updating
`nativeStrHelpers.set(name, idx + delta)`, also
`ctx.finalizeHelperStaleIdxToName.set(idx + delta, name)`. The original stale
entry stays (do not delete) — see the "multiple stale indices" edge below.

### The pass body — `repointFinalizeHelperSiblingCalls(ctx)`

Add to `src/codegen/expressions/late-imports.ts` (sibling of the reconcile it
supersedes for helper calls):

```ts
export function repointFinalizeHelperSiblingCalls(ctx: CodegenContext): void {
  const reverse = ctx.finalizeHelperStaleIdxToName;
  if (reverse.size === 0) return;                       // no helpers emitted
  const mod = ctx.mod;
  const numImpF = mod.imports.filter((i) => i.desc.kind === "func").length;

  // 1. Build the authoritative name → current-index map from `mod` (post-deadElim).
  const authorityByName = new Map<string, number>();
  for (let i = 0; i < mod.functions.length; i++) {
    const name = (mod.functions[i] as { name?: string }).name;
    if (name) authorityByName.set(name, numImpF + i);
  }

  // 2. The set of helper FUNCTION BODIES to rewrite (registry-membership gate).
  //    Only finalize-emitted helpers are rewritten; compilation-phase bodies are
  //    NEVER touched even if a call inside them numerically aliases a stale idx.
  const helperNames = new Set(reverse.values());

  function repoint(instrs: Instr[]): void {
    for (const instr of instrs) {
      const a = instr as any;
      if (
        (instr.op === "call" || instr.op === "return_call" || instr.op === "ref.func") &&
        typeof a.funcIdx === "number"
      ) {
        const name = reverse.get(a.funcIdx);          // is this a helper sibling call?
        if (name !== undefined) {
          const authoritative = authorityByName.get(name);
          if (authoritative !== undefined) a.funcIdx = authoritative;  // idempotent
          // else: name not in mod (dead-eliminated helper) → leave; it is
          //       unreachable by construction (its only callers are also dead).
        }
      }
      if (Array.isArray(a.body)) repoint(a.body);
      if (Array.isArray(a.then)) repoint(a.then);
      if (Array.isArray(a.else)) repoint(a.else);
      if (Array.isArray(a.catches)) for (const c of a.catches) if (Array.isArray(c.body)) repoint(c.body);
      if (Array.isArray(a.catchAll)) repoint(a.catchAll);
    }
  }

  for (const fn of mod.functions) {
    if (!fn.name || !helperNames.has(fn.name)) continue;  // GATE: helper bodies only
    repoint(fn.body);
  }
}
```

**Why the body gate (Q4) is correct.** A compilation-phase body's `call` may
numerically equal a stale helper index by coincidence, but that body's name is
NOT in `helperNames`, so the outer loop skips it entirely — it is never walked,
so a coincidental alias cannot be mis-rewritten. The inner `reverse.get` is a
second guard (only rewrites a call whose immediate matches a recorded stale
helper idx), making the pass doubly safe. **Assert** in the inner branch (under
a debug/env flag) that any rewritten call inside a helper body resolves to a
name in `authorityByName`, to convert a future regression into a loud error.

### Wire-in (the ordering is the whole point)

In `src/codegen/index.ts`, in BOTH finalize arms (the GC arm around line 1794
and the standalone/wasi arm around line 5522), insert the call **immediately
after `eliminateDeadImports(mod)` and before `ctx.indexSpaceFrozen = true`**:

```ts
    eliminateDeadImports(mod);
    repointFinalizeHelperSiblingCalls(ctx);   // #1899 — by-name authority, post-all-churn
    repairStructTypeMismatches(mod);
    peepholeOptimize(mod);
    ...
    ctx.indexSpaceFrozen = true;
```

It MUST run after dead-elim (so `authorityByName` reflects removed imports) and
after the last `reconcileNativeStrFinalizeShift` (all 6 sites precede line 1794
/ 5522 — verify each is upstream of the wire-in point in both arms). It must run
before freeze and before `stackBalance`/`emit` (which read the final indices).
`reconcileNativeStrFinalizeShift` and `eliminateDeadImports` are LEFT IN PLACE
unchanged — they remain index-bookkeeping for everything else; the new pass only
OVERRIDES the finalize-helper sibling-call subset by name.

### Edge cases

- **A helper baked at several stale indices over the run.** The reverse map is
  additive (every shift adds the new post-shift index, keeps the old); all such
  entries map to the same stable name, so whichever value a given body baked,
  `reverse.get` finds the name and re-points to the single authoritative index.
  This is the core of why B2 (name-anchored) cannot drift where the incremental
  delta-shift does.
- **A dead-eliminated helper** (name absent from `authorityByName`): leave the
  call. By dead-elim's reachability definition, if the helper was removed, every
  caller body was also removed, so the residual call is in dead code (or the
  module is already invalid for an unrelated reason). Do NOT throw here.
- **Reverse-map collision: two distinct helpers share a stale idx value.**
  Impossible within one settled index space (two live funcs cannot occupy one
  slot), but ACROSS shifts a freed slot could be reused by a different helper.
  Mitigation: since entries are additive and keyed by idx, a later `.set(idx,
  nameB)` overwrites `nameA` for that idx. This is correct ONLY if no surviving
  body still bakes `idx` meaning `nameA`. Guard: when adding a post-shift entry,
  if `idx` already maps to a different name, the OLD name's bodies were already
  shifted off `idx` by the same pass (they moved to `idx+delta`), so the
  overwrite is safe. The senior-dev MUST add a unit test for two helpers whose
  indices cross a shift boundary (below).
- **Non-string finalize helpers in `funcMap` only** (`__apply_closure`,
  `__call_fn_method_N`): they register via `registerFinalizeHelper(...,
  ctx.funcMap)`, so they land in the same reverse map. The pass keys off
  `mod.functions[].name`, which covers them identically — no string-specific
  code path. This is the Q2 scope extension that unblocks #1888 S2 / Slice 5.
- **Regex helpers** (`nativeRegexHelpers`): same treatment — route their
  registration through `registerFinalizeHelper(..., ctx.nativeRegexHelpers)`.

### Relationship to #1985 (subsumes its first two targets; does NOT block it)

#1985 (Option 2b — `FuncIdxCell` shared mutable cells updated by every shift
walker) and this #1899 pass are **complementary, overlapping mechanisms** for
the same class:

- **#1985 cells** prevent a stale capture at the *JS-variable* level (a holder
  observes the shift because it shares the cell). It covers captures that are
  NOT yet emitted into a body (e.g. `pendingMethodTrampolines[].methodFuncIdx`).
- **#1899 by-name pass** repairs indices ALREADY baked into emitted helper
  bodies, after ALL churn (including dead-elim REMOVAL, which cells do not model
  — a cell tracks +delta shifts, not the funcIdx remap dead-elim applies to
  `mod` bodies).

**This pass SUBSUMES #1985 targets (2) `nativeStrHelpers` entries and the
(3) late-import bridge captures** for the *emitted-body* case: once the by-name
pass is authoritative for finalize-helper sibling calls, those two targets no
longer need cells for the baked-call correctness. It does **not** subsume #1985
target (1) `pendingMethodTrampolines[].methodFuncIdx`, which is a pre-emission
capture in the compilation phase, nor #1985's dead-elim gap (cells don't model
removal at all). **Recommendation:** land #1899 first; then #1985 narrows to
target (1) only, and its `blocked_by: [2167]` can be re-evaluated — #1899 does
not unblock #2167 but reduces #1985's remaining surface to the single
trampoline site. Update #1985's scope note when #1899 lands.

### Detection hardening (land WITH this pass, not before)

Extend the always-on guard: once `finalizeHelperStaleIdxToName` exists, add a
post-pass assertion (env-gated, e.g. `JS2WASM_VALIDATE_FUNCREFS` or a new
`JS2WASM_VALIDATE_HELPER_CALLS`) that walks every helper body one more time and
fails LOUDLY if any sibling `call` whose funcIdx is in the reverse map does NOT
equal `authorityByName.get(<name>)`. This converts the silent
in-range-wrong-target failure (the exact #1899 symptom that `validateFuncRefs`
misses) into a named compile error. It presupposes the reverse map, so it ships
with this PR — never before.

### Test plan (keyed to the known late-shift repros)

1. **Resurrect the live repro under churn.** The exact #1899 repro no longer
   reproduces post-#1225, so the senior-dev MUST construct a churning case:
   compile (in `--target standalone` AND `--target wasi`) a program that (a)
   emits ≥2 sibling-calling string helpers (`+` → `__str_concat` → `__str_flatten`
   → `__str_copy_tree`; `.padStart` → concat+repeat+substring), AND (b) forces a
   finalize-import ADD after the helpers (a `let g: any` undefined-init path, or
   any host import landing post-helper), AND (c) forces a dead-elim REMOVAL of a
   finalize import (an unused builtin). Assert it **compiles, validates, and runs**
   to the correct value. Add as `tests/issue-1899-funcidx-authority.test.ts`.
2. **Two-helpers-cross-a-shift unit test** (the reverse-map collision edge):
   register two finalize helpers, run two consecutive reconcile shifts plus a
   dead-elim that removes one import, assert both helpers' sibling calls resolve
   to their authoritative indices (no off-by-one, no cross-wire).
3. **Idempotency / double-run unit test:** run `repointFinalizeHelperSiblingCalls`
   twice; the second run must be a byte-for-byte no-op (proves Q4 no-double-shift).
4. **Regression-hold the existing class tests** — all must stay green unchanged:
   `tests/issue-329-assign-closure-lateshift.test.ts`,
   `tests/issue-1677.test.ts` (the #618 default-GC-path guard — assert the pass
   is a hard no-op when `finalizeHelperStaleIdxToName` is empty, i.e. JS-host GC
   path, so the Math.*-trampoline corruption class cannot recur),
   `tests/issue-1809.test.ts`, `tests/issue-1839.test.ts`.
5. **#1888 consumer smoke** (Q2 scope proof): a standalone program exercising a
   closure-accessor (`__call_fn_method_N` via `__apply_closure`) — compile +
   validate, to confirm the pass covers the non-string finalize helpers and
   pre-empts the keystone #1888 S2 / Slice 5 recurrence.
6. **test262 conformance hold** — CI must show no net regression; the pass is
   pure index repair, so the standalone/WASI string-program pass count must not
   drop.

### Files touched (summary for the senior-dev)

- `src/codegen/context/types.ts` — add `finalizeHelperStaleIdxToName` field.
- `src/codegen/context/create-context.ts` — initialize it to `new Map()`.
- `src/codegen/native-strings.ts` — add `registerFinalizeHelper`; route the
  ~40 `nativeStrHelpers.set` sites through it.
- The other helper-registration modules (`object-runtime.ts` for
  `__apply_closure`/`__call_fn_method_N`, `binary-ops.ts`, `string-ops.ts`,
  `array-methods.ts`, `json-*`, `case-convert-native.ts`,
  `uri-encoding-native.ts`, `parse-number-native.ts`, `symbol-native.ts`,
  `map-runtime.ts`, `date-parse-native.ts`, `native-regex.ts`,
  `regexp-standalone.ts`) — route their finalize-helper `funcMap` /
  `nativeRegexHelpers` registrations through `registerFinalizeHelper`.
- `src/codegen/expressions/late-imports.ts` — add
  `repointFinalizeHelperSiblingCalls`; in `reconcileNativeStrFinalizeShift`,
  `flushLateImportShifts` re-base, and `shiftLateImportIndices`, also add the
  post-shift index to `finalizeHelperStaleIdxToName`.
- `src/codegen/index.ts` — call `repointFinalizeHelperSiblingCalls(ctx)` after
  `eliminateDeadImports(mod)` in BOTH finalize arms (≈line 1794 and ≈line 5522),
  before `ctx.indexSpaceFrozen = true`. Also the two re-base sites (≈7766, ≈9215)
  must mirror the reverse-map update.
- `src/emit/binary.ts` (optional, ships with this PR) — the helper-call
  detection-hardening assertion.
- `tests/issue-1899-funcidx-authority.test.ts` — new regression + unit tests.
- `CLAUDE.md` (addUnionImports section) — document the contract: finalize-emitted
  helper sibling calls are repaired by name post-churn; new finalize helpers MUST
  register via `registerFinalizeHelper` so the authority pass covers them.

---

## Implementation (senior-dev, 2026-06-21 — against upstream/main 0e482f2fc)

**Shipped a different, sound mechanism than the ratified B2 blueprint, because
B2 (the central `staleIdx → name` reverse map + by-name re-pointer) is
provably UNSOUND.** Implementation notes (the WHY, for the next maintainer):

### Why B2 (idx-keyed re-pointer) was rejected — measured, not theorised
I built B2 exactly as specified (central `registerFinalizeHelper` chokepoint
routing all ~70 registration sites; additive `finalizeHelperStaleIdxToName`
reverse map maintained by every shift pass; final post-dead-elim
`repointFinalizeHelperSiblingCalls` that re-points by name) and ran it against
the existing late-shift regression suite. It **corrupted correct modules**:
`#329`/`#1839` flipped from green to `__str_concat … not enough arguments` /
`__str_flatten call[1] expected (ref null 6) found i32.const`. Instrumentation
showed **94 re-points that CHANGED a value on a module that was already
correct** (e.g. every `call 1` rewritten to `call 0` because the reverse map
held a *stale* `1 → __str_copy_tree` entry while index 1 now legitimately
belonged to a different function).

Root cause of B2's unsoundness: **a funcIdx value is ambiguous across shifts.**
The reverse map is `staleIdx → name`, but after an index shift a freed slot is
reused by a *different* function, so a CORRECT baked `call <idx>` can collide
with a stale reverse-map entry for an unrelated helper. The spec's "additive,
later overwrites" mitigation does not hold: a surviving body can still bake the
old value meaning the old name. No idx-keyed map can both (a) repair a genuinely
stale call AND (b) leave a correct-but-numerically-colliding call untouched —
the two are indistinguishable by index. (A *fresh* map rebuilt right before the
pass collapses to a no-op; an *additive* map corrupts. There is no middle
ground.) The only sound name-anchoring is per-call **instruction-object**
identity captured at bake time — which is the B1 approach the architect rejected
for its ~150-site fragility (the spec under-counted it as 35). So neither B1 nor
B2 is a good fit.

### What actually recurs, and the sound fix
The existing ADD-direction machinery (`shiftLateImportIndices` /
`reconcileNativeStrFinalizeShift`) is already exhaustive: it walks every
`mod.functions` body AND keeps `funcMap` / `nativeStrHelpers` /
`nativeRegexHelpers` / `mapHelpers` / `pendingMethodTrampolines` in lockstep on
every import ADD. The genuine, unmodelled gap is the **REMOVE** direction:
`eliminateDeadImports` removes dead func imports and remaps every funcIdx
*inside `mod`* through its authoritative `fR` table (so the emitted module stays
internally consistent), but historically it touched **only `mod`** and left the
ctx side-tables stale by the removed-import delta. A consumer that bakes a NEW
`call` from a stale side-table AFTER dead-elim then targets the wrong function —
the live recurrence vector. The concrete post-dead-elim consumer today is the
`__unbox_number` repair in `fixups.ts` (`repairStructTypeMismatches` /
`fixupExternConvertAny`, which run immediately after dead-elim).

**Fix (one change):** `eliminateDeadImports(mod, ctx?)` — pass the context and
apply the SAME authoritative `fR` remap to the ctx side-tables (`funcMap`,
`nativeStrHelpers`, `nativeRegexHelpers`, `mapHelpers`, and the
`pendingMethodTrampolines` side-channel), in lockstep with the module, exactly
as the ADD-direction passes already do. This is the sound realisation of the
contract's Q1 intent ("dead-elim becomes index-bookkeeping that the
side-tables follow"). Properties:
- **Sound** — uses dead-elim's own `fR` (the authority), never guesses by idx.
- **Idempotent / no-op on the common path** — gated on `fR.size > 0` (a dead
  func import was actually removed); a hard no-op otherwise, which is the
  current-main case (hence no behaviour change, no test262 delta expected).
- **Zero per-site churn** — no `registerFinalizeHelper`, no reverse map, no
  touching the ~70 registration sites or ~150 bake sites. ~50 LOC in one file.
- **Backward-compatible** — `ctx` is optional; non-codegen callers (tests, the
  standalone rewriter) keep the old `mod`-only behaviour.

### Detection guard — investigated, NOT shipped
A name-identity post-freeze guard (`helper-map idx must equal the index of the
function of that name`) was prototyped and **withdrawn**: it false-positives on
the intentional `#40`/`#2191` public-name re-point in `case-convert-native.ts`
(`__str_toLowerCase` in the map deliberately points at the `__str_toLowerCase_uni`
body, while a dead, same-named ASCII body still sits at another index). Name↔index
identity is therefore not an invariant, so the guard is unsound as a check. The
only safe always-on check remains `validateFuncRefs` (out-of-range), already in
`binary.ts`.

### Files / tests
- `src/codegen/dead-elimination.ts` — `eliminateDeadImports(mod, ctx?)` + ctx
  side-table `fR` remap (the fix).
- `src/codegen/index.ts` — pass `ctx` at both finalize arms.
- `tests/issue-1899-funcidx-authority.test.ts` — unit (synthetic module: remap
  lockstep, fR-empty no-op, idempotency) + integration (churning closure/string
  + toLowerCase/toUpperCase across standalone/wasi/gc).

### Relationship to #1985 / #1888 (revised)
The "by-name authority pass subsumes #1985 targets 2 & 3" claim in the ratified
blueprint does NOT hold (B2 is gone). #1985's `FuncIdxCell` (shared mutable cell
observed by every shift walker) remains the right tool for **pre-emission**
captures (`pendingMethodTrampolines[].methodFuncIdx` etc.) and, unlike B2, is
sound for the ADD direction. This #1899 fix additionally covers the REMOVE
direction for the side-tables, which cells do not model. **#1985 is NOT subsumed
and stays open**; #1899 reduces, but does not eliminate, its surface. #1888 S2 /
Slice 5 (`__apply_closure` / `__call_fn_method_N`) are covered for the REMOVE
direction here because those funcMap entries are now remapped by dead-elim too;
their ADD-direction coverage was already in place via `shiftLateImportIndices`.
