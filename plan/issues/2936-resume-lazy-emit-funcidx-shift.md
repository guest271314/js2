---
id: 2936
title: "Standalone: late-import funcIdx-shift desync (raw-import + deferred-batch regime mix) — the __str_flatten invalid-module class blocking no-yield native generators"
status: done
assignee: ttraenkler/sr-funcidx
created: 2026-07-02
completed: 2026-07-02
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
sprint: 69
horizon: l
related: [2933, 2918, 1461, 1677, 1903, 2039]
umbrella: 2860
---

# Late-import funcIdx-shift desync: raw-import drift + deferred-batch flush

> Formerly #2930; id ceded to the parallel session's
> `2930-import-alias-name-mismatch-resolution.md` (landed on main first —
> same allocator race as the 2920→2933 re-id).

Blocking bug for #2933 (formerly tracked as #2920 in this session; id ceded to
PR #2424's issue): with the no-yield native-generator bails relaxed, ~1-3% of
no-yield generator test262 files produced an **invalid module**:

```
WebAssembly.instantiate(): Compiling function #6:"__str_flatten" failed:
  call[1] expected type externref, found i32.const of type i32
```

## Root cause (WHY — traced, not the original hypothesis)

The original diagnosis blamed "a late/union import registered during the
lazily-emitted resume function's param/body emit". Instrumented tracing showed
the shift does NOT fire during the resume emit at all. The real mechanism is a
**mix of the two index-shift regimes** during `collectAllSourceImports`:

1. Native-string helpers are emitted eagerly with 0 imports
   (`nativeStrHelperImportBase = 0`). `__str_copy_tree` sits at absolute
   index 0, `__str_flatten` at 1, and flatten's body bakes `call 0`
   (its `__str_copy_tree` sibling call).
2. `finalizeUnifiedCollector` adds `env.__make_callback` via **raw
   `addImport`** (the finalize regime): every defined-func index drifts +1,
   with the repair deferred to `reconcileNativeStrFinalizeShift`.
3. `addGeneratorImports` (the host `__gen_*` suite, needed because SOME
   generator in the file still requires the host path) opens a **deferred
   batch** via `ensureLateImport`, recording `importsBefore = 1` — while the
   module's baked refs are still on basis 0 — then flushes:
   - the flush shifts only refs `>= importsBefore` (+15), **missing**
     base-regime refs whose stale value sits below the raw import's insertion
     point (`copyTree = 0`, flatten's baked `call 0`), and
   - the flush's #1903 re-base sets `nativeStrHelperImportBase = 16`,
     **permanently cancelling** the pending +1 raw repair.
4. Final layout: flatten's `call 0` resolves to import #0 =
   `env.__make_callback(i32, externref) → externref` → the observed
   `call[1] expected externref, found i32` validation failure.

**Why it looked no-yield-specific:** every host-path generator shape normally
sets `state.unionFound`, so `addUnionImports` → `addUnionImportsAsNativeFuncs`
runs `reconcileNativeStrFinalizeShift` _incidentally_ between steps 2 and 3,
settling the drift. The no-yield relax makes those generators native
CANDIDATES → the generator-decl `unionFound` trigger is skipped → no
interleaved reconcile → the window opens.

**The bug exists on today's main** (latent, no relax needed): a native-
candidate generator that **captures an outer local** skips the `unionFound`
trigger (candidate) but still pulls the host gen-suite
(`sourceNeedsGeneratorHostImports` checks `generatorCapturesOuterScope`
separately). Minimal main-lane repro (tests/issue-2936.test.ts):

```ts
const greet = (n: string): string => "hi " + n; // arrow → raw __make_callback
export function test(): string {
  let n = 1;
  function* g() {
    yield n;
  } // candidate + outer capture → host suite batch
  void g();
  return greet("x"); // native strings → __str_flatten/copy_tree
}
// --target standalone: WebAssembly.validate === false before the fix
```

## Fix (src/codegen/expressions/late-imports.ts, one hunk)

Settle the finalize-regime drift **at the deferred-batch record point**: in
`ensureLateImport`, call `reconcileNativeStrFinalizeShift(ctx)` immediately
before recording `pendingLateImportShift.importsBefore`. The mixed state is
unrecoverable after the flush (stale defined refs and correct import refs
collide by value in `[base, importsBefore)` — no post-hoc walker can
distinguish them), so the record point is the single sound settle point. This
kills the whole class (ANY raw finalize-regime import followed by ANY deferred
batch), not just `__make_callback` + `__gen_*`.

- No-op unless a raw import actually landed since the last settle (added = 0).
- Hard no-op on gc/host (`nativeStrHelperImportBase` stays -1).

Rejected alternatives:

- (i) "register resume-path imports up-front" — misdiagnosis; the shifting
  imports are not from the resume path.
- (ii) extend `shiftAsyncSideChannelFuncIdxs` — the maps ARE covered by the
  walkers; the bug is regime interleaving, not a missing side-channel key.
- (iii) name-based repoint at finalize — unsound here: the flush re-base has
  already destroyed the information which refs are stale.
- Converting `finalizeUnifiedCollector`'s raw addImports to batched
  ensureLateImport — fixes only this instance, changes refusal-gating
  semantics for some names, leaves the class open.

## Validation

- **Repros**: `obj-ptrn-empty.js` + `scope-paramsbody-var-close.js` through the
  runner's standalone path with the two #2933 bails relaxed: compile_error
  (invalid module) → **pass**.
- **542-file no-yield corpus** (deterministic sample incl. both repros,
  relax on): pre-fix **17 invalid**, post-fix **12 invalid, 0 of them the
  funcIdx-shift class**, 0 new invalids, crash bucket identical (25, all
  pre-existing "Cannot convert object to primitive value").
  Residual attribution (all verified per-lane):
  - **10 invalid on pristine main even without the relax** (standalone-lane
    bugs unrelated to generators-native: struct.new arity in dstr defaults,
    externref coercion in forbidden-ext/b2, closure local.set typing) — out
    of scope, pre-existing.
  - **2 relax-lane-only**: `gen-meth-dflt-obj-init-undefined.js` (+ static
    variant) — whole-pattern default (`{x} = {}`) on a generator-method param
    mis-types the state struct (`struct.new[k] expected i32, found externref`).
    **The #2933 relax PR must bail `param.initializer` on pattern params in
    the no-yield candidate path (or fix the typing) before relaxing.**
- **Byte-inert**: 60 non-generator + 60 generator test262 files × {gc,
  standalone}, sha256 vs origin/main — all 240 identical.
- **Tests**: tests/issue-2936.test.ts (main-lane repro, standalone validates +
  gc lane unchanged); generator equivalence suite (36) green;
  issue-1461/1677 suites — 4 failures in issue-1461.test.ts
  (Symbol.isConcatSpreadable) are pre-existing on pristine main (verified A/B).

## Handoff to #2933 (relax PR)

With this fix on main, relax the two bails on branch
`issue-2920-standalone-native-sync-generator-resume` (rename the issue file to
2933-\*.md, id: 2933, claim via claim-issue.mjs):

1. `buildNativeGeneratorPlan` — `if (suspendCount === 0) return null;`
2. `isNativeGeneratorCandidate` — terminal `plan.states.some(...yield...)` →
   `return plan !== null;`
   PLUS the new bail for pattern-param `initializer` (the 2 residuals above), and
   re-run the corpus (the sample list derivation: no-yield generator files via
   `grep -rlE 'function\s*\*|^\s*\*[A-Za-z_$#]|\*method|\*gen' test262/test/language
--include='*.js' | xargs grep -LE 'yield|async'`, every-4th + repros; compile
   through `runTest262File(..., "standalone")`).
