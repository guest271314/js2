---
id: 2965
title: "Standalone dynamic-descriptor/defineProperty cluster (~694 host-pass→standalone-fail: defineProperty 398 + gOPD 184 + defineProperties 112)"
status: in-progress
assignee: ttraenkler/fable-6
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
goal: standalone-mode
related: [2372, 2896, 2944, 2915, 2861, 2863, 2907, 2962]
origin: "2026-07-02 July Fable audit §3 — reflective descriptor cluster in the standalone correctness-fail bucket"
---

# #2965 — standalone dynamic-descriptor/defineProperty cluster

## Problem

**773 tests** under `built-ins/Object/{defineProperty,getOwnPropertyDescriptor,
defineProperties}` pass on the js-host lane but fail (694) or CE (79) on the
standalone lane (verified against `test262-standalone-current.jsonl` ×
`test262-current.jsonl`, 2026-07-02 — the audit's 398+184+112 reproduce
exactly).

## Measured triage (deliverable 1 — by construct, full 773)

| class | count | mechanism | status |
| --- | --- | --- | --- |
| gOPD-on-builtin (incl. builtin-proto receivers) | ~178 (60 CE `__get_builtin` + 118 fail) | `gOPD(Array.prototype, "forEach")` etc. needs the builtin-object MOP; descriptor `.value` must be the method value | follow-up — overlaps #2861/#2863/#2896 machinery (`__builtinfn_gopd`) |
| defineProperties 5-b/6-a slab | ~300 | mixed: materialized-typeof breakage (fixed below), array/arguments own-prop MOP, accessor attribute fidelity, destructive `verifyProperty` | partially fixed (typeof); rest follow-up |
| arguments-object receivers | ~82 | defineProperty on mapped `arguments` | follow-up (see #2667 lineage) |
| gOPD non-string literal keys | ~24+ | ToPropertyKey not applied → undefined → opaque throw on `.value` | **FIXED** (slice 3) |
| boxed-wrapper receivers (`new String/Number/Boolean`) | ~18 | defineProperty on boxed wrappers | follow-up |
| global-object receivers (`this` at top level) | ~10 | needs #2907 global carriers | follow-up |
| assert.throws(TypeError) missing | ~32 | missing spec throws (array length, non-extensible, etc.) | follow-up |

The 279 "uncaught Wasm-GC exception (non-stringifiable payload)" entries are
NOT one bucket — they decompose into the classes above (the opacity itself is
#2962's scope; the throws here are mostly genuine wrong-behavior throws).

## Root causes found + FIXED in this branch (deliverable 2)

1. **Module-init double-compile state leak** (`src/codegen/declarations.ts`).
   `compileModuleInitBody()` runs twice by design (second pass sees the final
   inlinable-function registry). Statement compilation mutates program-order
   state (`definedPropertyFlags`, `frozenVars`/`sealedVars`/
   `nonExtensibleVars`); pass 2 started from pass 1's END state, so **every
   first top-level `Object.defineProperty(o,k,{value:v≠0})` threw a spurious
   "Cannot redefine property"** (needsValueCompare guard vs the struct field's
   zero-init default) and defines preceding `Object.freeze` compiled as
   already-frozen. Fix: snapshot before pass 1, restore before pass 2. Affects
   ALL lanes' top-level code (test262's runner wraps bodies in `test()`, so
   the corpus mostly doesn't hit it — but user code / playground does).

2. **`__typeof` standalone native was a `ref.null.extern` stub**
   (`src/codegen/index.ts` `addUnionImportsAsNativeFuncs`). Every MATERIALIZED
   typeof (`var t = typeof x`, typeof through a param, and the runner's
   untransformed paren-form `typeof(o.p)` — common in ES5-era tests) produced
   null: `t === "<tag>"` false for every tag, `t.length` trapped. Fix: real
   classifier mirroring the `__typeof_*` predicates (null→"undefined",
   box_number→"number", box_boolean→"boolean", $BigInt→"bigint",
   $AnyString→"string", else→"object"), returning inline NativeString
   constants (type-index-only instrs — late-import-shift safe, #2515
   discipline). Known pre-existing conflation kept: null externref is
   indistinguishable from undefined (typeof null → "undefined"), same as the
   `__typeof_undefined` predicate. gc/host lane untouched (block is
   `ctx.wasi || ctx.standalone` gated).

3. **gOPD literal-key ToPropertyKey** (`src/codegen/expressions/calls.ts`).
   The struct fast path required a string-literal key; `gOPD(obj, -20)` /
   `gOPD(obj, true)` fell to the dynamic `__getOwnPropertyDescriptor` native,
   which answers undefined for typed-struct receivers. Fix (standalone-gated):
   canonicalize numeric/boolean literal keys to their §7.1.19 string form so
   they hit the same fast path.

## Test results

- `tests/issue-2965.test.ts` — 11/11 pass, host-free asserted.
- gOPD `15.2.3.3-2-*` (47 files, real runner, standalone): **+23 flips, 0
  regressions** vs baseline.
- 155-file deterministic sample of the 694: +8 in-sample (the corpus bulk
  needs the follow-up MOP classes above).
- 221-file regression sweep over baseline-PASSING standalone tests across all
  categories: 215 pass + 6 Temporal skip-scope artifacts, **0 regressions**.
- Equivalence-suite run was IN FLIGHT at suspend (see below).

## Suspended Work (2026-07-02, budget wind-down)

- **Worktree**: `/workspace/.claude/worktrees/agent-ad440b36468717786`
  (harness worktree of agent fable-6; safe to recreate a fresh worktree from
  the branch instead).
- **Branch**: `issue-2965-standalone-descriptor-cluster`, pushed to origin
  (ttraenkler fork) at `5bcb30d70` — all three fixes + tests committed. No PR
  opened yet.
- **Done**: triage (above), 3 root-cause fixes, unit tests, scoped corpus
  A/Bs + regression sweep (all clean).
- **Remaining to ship this slice**:
  1. Finish the gc-lane guard: `npx vitest run tests/equivalence/` was
     running at suspend and showed failures in `tagged template literals`,
     `coercion/arithmetic-add`, TDZ blocks — **NOT yet A/B'd against the
     unmodified base**. Verify those fail on `upstream/main` too (expected:
     pre-existing, my probes of the touched paths were clean, and slice 2/3
     are standalone-gated; slice 1 touches all lanes) before opening the PR.
     Use `git stash`-free A/B: `git diff > p.patch; git checkout src/; run;
     git apply p.patch`.
  2. `git merge upstream/main`, re-run `tests/issue-2965.test.ts`, open PR
     via `gh pr create -R loopdive/js2 --head ttraenkler:issue-2965-standalone-descriptor-cluster`,
     set `status: done` in this file in the PR, CI watcher, `/dev-self-merge`.
  3. This issue file (created at suspend) rides the PR.
- **Follow-up classes** (deliverable — file separately or fold into existing
  issues): gOPD-on-builtin → extend #2861/#2863; arguments-object
  defineProperty MOP; boxed-wrapper receivers; global-object receivers
  (#2907); missing spec TypeErrors (array length / non-extensible);
  `__obj_find` illegal-cast on residual dynamic non-string keys (2 files).
- **Probes** (gitignored, in the worktree's `.tmp/`): `probe-2965-matrix.mts`
  (slice 1), `probe-2965-typeof2.mts` + `probe-2965-streq.mts` (slice 2),
  `probe-2965-key2.mts` (slice 3), `probe-2965-corpus2.mts` + target lists
  (corpus A/B harness — mirrors the real runner per the #2372
  harness-faithfulness lesson).
- **Claim**: released at suspend (`claim-issue.mjs --release`). Re-claim with
  `--force` against this branch to resume.
