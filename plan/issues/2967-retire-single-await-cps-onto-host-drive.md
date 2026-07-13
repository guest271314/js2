---
id: 2967
title: "Async engine convergence: retire emitAsyncStateMachine/splitBodyAtAwait onto the #2906 host-drive engine; widen planLinearAwaits gaps once for both lanes"
status: done
completed: 2026-07-11
assignee: ttraenkler/fable-senior
created: 2026-07-02
updated: 2026-07-13
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
goal: async-model
sprint: 71
parent: 1042
depends_on: [1042, 3134]
related: [2906, 2957, 1373b, 3134]
origin: "#1042 host-drive PR (2026-07-02) — deliberate scope cut: the CPS lane was left byte-stable; convergence is its own measured step"
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/codegen/async-cps.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/closures.ts
  - src/codegen/statements/nested-declarations.ts
---

# #2967 — One async lowering engine: fold the single-tail-await CPS lane into the host drive, then widen the shared gaps

## Problem

#1042 (2026-07-02) re-targeted the JS-host lane onto the #2906 N-state
`$AsyncFrame` resume machine with a host settle backend (`async-frame.ts`,
`asyncFnNeedsHostDrive`) — but **deliberately only for the shapes the old CPS
lane rejected** (multi-await, try/finally-across-await). The single-tail-await
shapes still take `emitAsyncStateMachine`/`splitBodyAtAwait` (`async-cps.ts`),
so the JS-host lane runs TWO suspension engines:

- `asyncFnNeedsCps` → the legacy `.then`-chaining CPS (single tail await);
- `asyncFnNeedsHostDrive` → the #2906 frame engine (host settle backend).

The July audit's convergence end-state is ONE engine. Single-await is a strict
subset of the N-state machine (N=1), so the CPS lane is retirable — but that
flip changes emitted code for the single-await population (the largest async
population), so it must be measured, not assumed.

## Approach

1. **Flip routing**: make `asyncFnNeedsHostDrive` claim everything
   `planLinearAwaits` accepts (drop the `!asyncFnNeedsCps` exclusion);
   short-circuit `asyncFnNeedsCps` to false (or delete the CPS arm in
   `function-body.ts`). Keep the lone-combinator + spill-safe gates.
2. **Full-corpus A/B** (CI sharded test262, host lane): net must be ≥ 0 with
   no async bucket regression. The engines differ observably: the frame engine
   settles a pre-allocated pending promise via `Promise_settle_resolve`; the
   CPS lane returns `Promise_then2`'s chained promise. Watch promise-identity
   and unhandled-rejection-timing tests specifically.
3. On a measured non-negative net: delete `emitAsyncStateMachine`,
   `splitBodyAtAwait`, `compileNestedAwait`'s CPS arm, the `asyncCpsActive`
   plumbing, and the `collectAsyncCpsImports` CPS-only detection (keep the
   host-drive import registration).
4. **Then** widen the remaining `planLinearAwaits` gaps ONCE for both lanes
   (wasi native backend + host backend inherit together):
   - try/catch-across-await (the reject step adapter already delivers
     ERROR/MODE_THROW; the catch clause becomes a state-arm handler),
   - `return`-in-try (return-through-finally),
   - nested/buried await (await in non-canonical statement positions),
   - await in loops/branches (needs a real CFG, coordinate with #1373b).

## Producer fix owed (stack-balance ratchet, from the #1042 PR)

An UNTYPED resume binding (`const seq = await f()` with no annotation) is
externref on the host lane (`resumeBindingValType` falls back to externref),
so downstream numeric uses (`seq.toString()`, arithmetic through call args)
lean on the stack-balance fixup net's externref→f64 unbox — the #1042 PR grew
`call-arg-coerce` 6→7 (playground `js/async.ts` `main`) and refreshed the
baseline (sanctioned path; the same PR banked `default-value-lossy` 78→42).
The producer fix: resolve unannotated resume-binding types from the checker's
awaited type (`Promise<T>` → T → `resolveWasmType`) — but it must be applied
CONSISTENTLY in all three `resumeBindingValType` consumers (spill fields,
resume-fn binding locals, the spill-safe gate) and decided per-lane (typing
wasi bindings changes the wasi lane's frames — measure). Fold into this
issue's engine-convergence pass; ratchet `call-arg-coerce` back to ≤6 as the
acceptance check.

## Also filed here (pre-existing, probe-verified on main 2026-07-02)

- `const p = f(); return await p;` — awaiting a promise held in a LOCAL
  (rather than a direct call operand) resolves to `null` on the host lane in
  both source orders. Triage where the identifier-operand await loses the
  promise (likely the call-site wrap / consumed-as-value classification, not
  the suspension engine).
- `tests/async-function.test.ts` fails to LOAD on main (`Cannot find module
'./helpers.js'` — helpers moved to `tests/equivalence/` long ago); the suite
  silently runs 0 tests. Fix the import path or fold the file into
  `tests/equivalence/async-function.test.ts`.

## Acceptance criteria

- One suspension engine on the JS-host lane (`async-frame.ts`);
  `emitAsyncStateMachine`/`splitBodyAtAwait` deleted.
- Full-corpus A/B recorded in this file: async cluster net ≥ 0.
- try/catch-across-await works on BOTH lanes (wasi + host) via the shared
  engine, with tests.
- The two pre-existing bugs above triaged (fixed or split out).

## Implementation notes (slice 1 — routing flip, 2026-07-10)

Resumed from fable-senior1 (agent died mid-task with the implementation
uncommitted in its worktree; work recovered, verified against current main,
committed by fable-senior2).

**What changed and WHY:**

- `decideAsyncActivation` (`src/codegen/async-activation.ts`): host-drive is
  now checked FIRST; the CPS arm is the fallback. Both engines return a real
  host Promise and the call-site contract (`Promise_resolve` assimilation) is
  engine-invariant, so the lowered _population_ is unchanged — only the engine
  per member flips.
- `asyncFnNeedsHostDrive` (`src/codegen/async-frame.ts`): the #1042
  `!asyncFnNeedsCps` disjointness exclusion is DROPPED — the N-state machine
  claims the single-tail-await population (N=1 case). The lone-combinator and
  spill-safe gates are kept verbatim.
- **Carve-out 1 — pattern/rest params (CPS-shaped only)**: the destructuring
  prologue derives locals in the ENTRY fn that the fresh resume
  FunctionContext never sees (the frame captures raw wasm params BY NAME —
  the async-gen gate rejects pattern params for the same reason). The CPS
  continuation snapshots derived locals by value from the outer frame, so
  those shapes stay CPS (correct-or-CPS, never correct-or-broken). Non-CPS
  pattern-param shapes keep their pre-#2967 host-drive routing (pre-existing
  gap, not widened here).
- **Carve-out 2 — lifted closures**: `planAsyncClosureActivation` re-lanes
  the CPS-shaped subset back onto CPS. Host-drive in the lifted-closure
  context is the parked #2646 33-regression class (continuation
  capture-struct / `__self` interplay unvalidated). The whole closure
  population is byte-stable across this flip; closure migration is a later
  slice and gates the final CPS deletion.
- `declarations.ts` import registration: post-flip both predicates can be
  true for one fn; registering the superset (CPS trio ⊂ host-drive six) is
  hazard-free for every routing outcome.

**Local validation (post upstream/main merge, 2026-07-10):**

- `tests/issue-2967-engine-convergence.test.ts` — 10/10 pass (routing WAT
  assertions + behavior incl. reject-path fidelity).
- `tests/issue-1042-host-drive.test.ts`, `tests/issue-2957.test.ts`,
  `tests/issue-2895-async-frame.test.ts`, `tests/async-await.test.ts` — 34/34.
- `tests/async-census.test.ts`, `tests/issue-2906-async-multiawait.test.ts`,
  `tests/issue-2174-async-closure-dynamic-call.test.ts` — pass.
- `tests/promise-combinators.test.ts`: 2 failures ("undefined is not
  iterable" on `Promise.all`/`Promise.race` with resolved values) —
  **pre-existing**: reproduced identically on a pristine `upstream/main`
  control worktree (531588802f). Not caused by the flip (that shape is a
  lone-combinator await, which the gate still declines → routing unchanged).

**Measured behavior delta (deliberate, an improvement):** a wasm-side throw
AFTER resume now settles the result promise with the original Error payload
(the frame engine's dispatch `try`/`catch $exn` → `Promise_settle_reject`
unwraps the exn payload), where the CPS lane leaked a raw
`WebAssembly.Exception` with no message. Promise-identity also differs
observably (pre-allocated pending promise settled via `Promise_settle_resolve`
vs `Promise_then2`'s chained promise) — the full-corpus A/B on this slice's PR
CI is the gate; watch promise-identity + unhandled-rejection-timing buckets.

**Next slices:** (2) delete CPS engine on a banked non-negative A/B;
(3) widen `planLinearAwaits` (try/catch-across-await first); plus the
producer fix (typed resume bindings, ratchet `call-arg-coerce` back to ≤6).

## Slice 1 A/B — BANKED (2026-07-10, merge_group run 29117178921)

PR #2871 merged via the queue. Full-corpus merge_group A/B, 48,088 tests
(js-host lane): **net −1**, where the single delta is one
`pass → compile_timeout` on a ≤5000ms-baseline test — classified `ct_flake`
(runner-load noise) by the gate itself. **Regressions excluding
compile_timeout: 0. Regressions with wasm-hash change: 0. Improvements: 0.**
The flip is measured net-neutral — the "population unchanged, engine per
member flipped" prediction held exactly. Acceptance criterion "async cluster
net ≥ 0" is met.

## Pre-existing-bug triage (acceptance item, 2026-07-10)

- **`const p = f(); return await p;` → null/NaN**: ROOT-CAUSED and split out
  as **#3134**. `resolveWasmType` unwraps `Promise<T>` → T (f64) on the host
  lane (src/codegen/index.ts:11848), so a Promise-typed local coerces the real
  promise externref through `__unbox_number` → NaN at the DECLARATION
  (WAT-verified). Not a suspension-engine bug; same hazard class the #2905
  wasi-carrier fix addressed at line 11847. Fix is a measured rep change —
  see #3134 for the two fix directions.
- **`tests/async-function.test.ts` fails to load**: STALE — the file no
  longer exists on main; the suite lives at
  `tests/equivalence/async-function.test.ts` and passes 7/7.

## Slice 2a — host-drive closures (2026-07-10, this PR)

`planAsyncClosureActivation` now ADMITS `host-drive` decisions instead of
re-laning them to CPS / parking them. Why the #2646 park no longer applies:
the park predates #2865's resume-fn environment re-establishment —
`ensureAsyncResumeFunction` re-runs the `__self` capture-struct
materialization (`selfCaptureLayout`), threads capture-cell deref routing
(`boxedCaptures`) and `readsCurrentThis`. Local validation (7 new suite
cases): multi-await fn-expr callback through the sig-dispatch ladder,
captured outer locals across awaits, capture cells, single-await captures,
discarded-tail bare await (the 22-regression CPS-emit bug — CORRECT on the
frame), bare-await + promise-return adoption (the 23rd), rejection. All pass.

Three PRE-EXISTING boundaries probed and control-verified identical on
pristine main (NOT slice-2a scope):

- `(): Promise<T>`-typed runner boundary → NaN (#3134);
- `cb: any` / untyped-param call → the callee body compiles to
  `return ref.null` (general any-callee gap; even SYNC closures return null
  through it — likely the TRUE #2646 null_deref mechanism, since test262's
  `asyncTest(testFunc)` is exactly this boundary);
- local-env wasi trio in issue-2906-gap3 + 7 AsyncFromSyncIterator/
  symbol-async-iterator e2e failures (identical on pristine main).

Remaining CPS population after 2a: concise arrow bodies
(`async x => await P`, non-block — planLinearAwaits can't drive), and the
pattern/rest-param carve-out. Those are slice 2b's to migrate; deletion (2c)
follows.

## Slice 2a park fix (2026-07-11, PR #2873 bot park — merge_group run 29120059791)

The merge_group A/B for the closure flip came back **net −36** (37
regressions / 1 improvement; buckets null_deref 32 + wasm_compile 5, all 37
with wasm-hash changes), and auto-park held the PR. Root-caused to TWO
distinct emit bugs in the newly-admitted class — NOT the `__self`/capture
interplay the slice-2a rationale above assumed #2865 had fixed, and NOT the
"pre-existing any-callee gap" triage note (control disproved: all 37 files
PASS on pristine main, where these closures never reach host-drive):

1. **Wrapper-struct RTT mismatch at the typed-param call boundary (32
   null_derefs).** Activating the async machine rewrites the closure's
   result to externref (the Promise), so the value site allocates the
   closure under the `(...) -> externref` signature's funcref-wrapper
   struct. A TYPED consumer (`asyncTest(fn: () => void)` — the test262
   harness shim) casts the incoming externref to the wrapper of its
   _declared_ signature instead. Wrapper structs are layout-identical but
   chained `sub final` under the FIRST wrapper the module created, so
   WasmGC canonicalization does NOT merge them — the cast nulls out and the
   funcref fetch traps ("dereferencing a null pointer in asyncTest()").
   Whether a module survived was pure wrapper-creation ORDER (a body using
   only `asyncTest` casts against the root wrapper and works; adding
   `assert.throwsAsync` — `() => any`, compiled first — makes the
   externref-result wrapper the root and every void-typed cast a sibling
   downcast). Main "passes" these files only because the legacy path
   compiles the closures as SYNC VOID functions, so declared == actual
   wrapper. **Fix (emit repair, calls.ts callable-param dispatch): cast the
   externref callee to the wrapper ROOT (the guaranteed supertype of every
   wrapper), fetch the funcref from the root's field 0, and re-cast self
   per dispatch arm to that candidate's struct.** The funcref `ref.test`
   (exact signature) keeps doing the discrimination it always did. This
   also fixes the same latent order-dependence for covariant SYNC closures
   (`() => string` passed as `() => void`) — the old "V8 canonicalizes
   same-layout structs" comment was wrong for the chained wrappers.
   Modules whose declared wrapper already IS the root emit byte-identically.

2. **Frame spill layout vs body-compile local rebinding (5 wasm_compile).**
   The spill fields are typed from `resolveSpillLocalValType` (TS declared
   type) BEFORE the body compiles, but body compilation can lawfully rebind
   or re-type the local: (a) a body local mutably captured by a NESTED
   closure gets CELL-BOXED at the closure's creation site (localMap →
   `(ref null $cell)`), so the suspend spill-back emits `struct.set[1]
expected i32, found (ref null N)` (await-using microtask tests,
   asyncDispose invokes-return); (b) a ref-typed guess can diverge from the
   body's inferred rep (`const expected = [prom]` → spill guess
   vec<externref>, body vec of the #3134-unwrapped struct —
   fromAsync/async-iterable-input-does-not-await-input). **Fix (admission
   tightening, `asyncClosureCellSpillHazard` in async-frame.ts): decline
   host-drive for a closure whose spill set contains a body-declared local
   that is (class 1) nested-captured ∧ assigned, or (class 2) a
   non-resume-binding ref/ref_null spill guess.** Hazardous bodies re-lane
   exactly as pre-slice-2a (CPS if CPS-shaped, else legacy) until the frame
   layout is made cell-/rep-aware (phase 3). The same hazards exist
   latently on the DECLARATION host-drive lane (slice 1, on main) — no
   corpus instance, left untouched deliberately.

Measured (branch, post-fix): the full 37-file regressed set **37/37 pass**
via `runTest262File` (A/B control: all 37 pass on pristine main, 4 sampled +
2 wasm_compile reproduced failing on the pre-fix branch). Directory sweep of
the affected suites — fromAsync (95), await-using (+syntax), AsyncDisposable-
Stack/disposeAsync, AsyncFromSyncIteratorPrototype/throw; 210 files — vs the
js-host baseline: **0 regressions, +17 improvements** (fromAsync
mapfn-throws-close-iterator ×4, this-constructor-unsettable-closes ×2,
intrinsic-iterator-symbols; await-using initializer-dispose ordering ×4;
AsyncFromSync throw paths ×6) — the intended win of real async closures over
the legacy sync-void lowering. engine-convergence suite 20/20 (3 new
park-fix cases codifying both mechanisms); issue-2957/1042-host-drive/2895/
async-await/async-census 47/47; closure/callback equivalence suites green
(2 pre-existing main-identical failures in optional-direct-closure-call,
wasi trio in 2906-gap3 — control-verified).

Follow-up candidates filed in-issue (not blocking): the property-call closure
dispatch (calls-closures.ts) still casts to the declared wrapper — same
latent order-dependence, no corpus hit; declaration-lane spill hazards
(above); making the frame layout cell-aware retires the class-1 decline.

## Slice 2b (part 1) — concise arrow bodies (2026-07-10)

`planLinearAwaits` now admits the ONE drivable concise shape:
`async (…) => await P` (possibly parenthesized) → the single-segment
isReturnAwait plan (semantically `{ return await P; }`). Exactly the concise
population `splitBodyAtAwait` owned, so those closures move onto the frame
engine (concise bodies exist only on arrows — observable only through the
slice-2a closure admission; declarations and the wasi closure park are
byte-stable). Richer concise bodies (`=> (await P) + 1` — await nested in an
expression) are NOT linear-canonical and keep the legacy fallback; their
wrong legacy VALUE (NaN) is pre-existing and belongs to slice 3's
nested/buried-await widening. Remaining CPS population after 2b-1:
pattern/rest-param shapes only (2b-2).

## Slice 2b (part 2) — pattern/rest params (2026-07-11)

The last CPS _population_ carve-out is retired. Mechanism (async-frame.ts) —
**pattern-DERIVED param bindings ride the frame as LIVE-INITIALIZED spill
fields**, chosen over "extra param fields" deliberately:

- Both activation entry points (`maybeActivateAsync`, the closure body emit)
  run AFTER the entry fn's param destructuring prologue, so every derived
  binding is a live entry local at `emitAsyncFrameStateMachine` time.
  `collectDerivedPatternParams` resolves each bound name through
  `fctx.localMap` and takes the local's ACTUAL wasm ValType — no TS-resolved
  guess, so the #2873 class-2 rep-divergence hazard cannot apply to them.
- `buildAsyncFrameInfo` excludes the derived names from the liveness-computed
  spill set and appends them as spill entries; `info.derivedSpillInit` maps
  their spill indices to entry locals, and the frame `struct.new` initializes
  those fields from the live locals instead of `defaultSpillInstr`.
- Being ordinary MUTABLE spill fields, they are restored at every resume
  re-entry AND stored back at every suspend (`storeSpills`) — which preserves
  the CPS continuation's snapshot semantics for a binding MUTATED before the
  await (param fields, by contrast, are immutable and never stored back; a
  param-field capture would silently lose such mutations for exactly the
  population being migrated).
- Rest params never needed the carve-out: an identifier rest param IS a raw
  wasm param (the caller builds the vec — `ctx.funcRestParams`), captured by
  name like any other param. Gate dropped; regression-tested.
- The routing gate keeps ONE decline: a derived binding mutably captured by a
  NESTED function-like (body compile cell-boxes it — the #2873 class-1 hazard
  applied to derived names, which `asyncClosureCellSpillHazard` skips via its
  `declByName` gate). `patternParamCellHazard` re-lanes those CPS-shaped
  bodies to CPS (correct-or-CPS; the CPS lane's own through-cell mutation
  loss there is pre-existing — same emitter main routes that shape to).
  Phase 3 (cell-aware layout) retires the decline.
- Bonus fixes: (a) non-CPS pattern shapes that ALREADY routed host-drive (the
  pre-#2967 derived-local gap — default-initialized externref spills the
  resume fn never saw a value for) now deliver correct values; (b) the same
  applies on the WASI drive lane (`asyncFnNeedsDrive` never gated patterns),
  since the capture mechanism is lane-independent.

Byte-stability: identifier-only-param functions produce an empty
`derivedParams` list → frame layout and emission byte-identical.

Local validation: engine-convergence 32/32 (7 new 2b-2 cases: object/array
patterns, mutation-before-await, rest, multi-await pattern gap, concise×
pattern, cell-hazard routing pin); 1042-host-drive/2957/2895/async-await/
async-census/2906-multiawait/2174 60/60. Remaining CPS population after 2b:
NONE (only hazard re-lanes). 2c (delete the CPS engine) is unblocked pending
this slice's merge_group A/B.

## Slice 2 re-scope (why deletion isn't next)

The banked A/B unlocks deletion **per the flip**, but slice 1 deliberately
kept two populations on CPS: (a) lifted closures (the parked #2646
33-regression class), (b) pattern/rest-param CPS-shaped decls. Deleting
`emitAsyncStateMachine`/`splitBodyAtAwait` now would strand both. So the
actual gate for deletion is: **slice 2a — migrate CPS-shaped closures onto
the frame engine** (fix the capture-struct/`__self` interplay in the
lifted-closure context), **2b — pattern/rest params** (spill the
prologue-derived locals into the frame), **2c — delete CPS**. Widening
(try/catch-across-await) remains slice 3.

## Phase 3 spec — cell-aware frame layout (the true 2c gate; 2026-07-11)

After 2b the CPS population is only the **hazard re-lanes**: (class 1)
spill/derived locals cell-boxed by a nested mutable capture; (class 2)
non-resume-binding ref-typed spill guesses. Deleting CPS now would strand
those on the legacy sync fakery (wrong under suspension — the await-using
microtask cluster rides the class-1 decline TODAY). So 2c decomposes:

**3a — retire class 1 by FORCE-BOXING (design verified against source):**

- Key verified mechanics: (i) the resume prologue's `allocLocal(name)` makes
  a segment lead's `let`/`const` REUSE that binding
  (variables.ts `isHoistedLetConst`: `existingIdx >= params.length`), so the
  #2692 let/const eager-boxing race does NOT apply inside the resume fn;
  (ii) the declaration-init path is already box-aware
  (variables.ts `boxedForInitStore`, #1177/#2692 — writes the init through
  the cell when `fctx.boxedCaptures` has the name); (iii) closure creation
  ALIASES a pre-existing `boxedCaptures` cell instead of re-boxing
  (closures.ts `alreadyBoxed` branch).
- Therefore: for each spill (or 2b-2 derived-param) name matching the class-1
  predicate, type its frame field `(ref null $__ref_cell_<declaredT>)`;
  create the cell at the ENTRY fn's frame `struct.new`
  (body-local: `struct.new $cell(<default>)`; derived param: box the live
  entry local — reuse the `derivedSpillInit` hook); in the resume prologue,
  restore the cell local, bind the NAME to it, and register
  `resumeFctx.boxedCaptures.set(name, {refCellTypeIdx, valType})`. Reads /
  writes / declaration-inits / nested-capture aliasing then all flow through
  existing machinery; `storeSpills` stores the cell ref (field type matches);
  cell IDENTITY survives suspends (same heap object restored), so nested
  closures observe post-await writes and vice versa.
- The predicate does NOT need to exactly mirror closures.ts's boxing
  decision: force-boxing is SELF-FULFILLING (over-approximation just adds an
  indirection, still correct). This also fixes the latent declaration-lane
  class-1 hazard (no corpus instance, slice-1 note).
- Retires: `asyncClosureCellSpillHazard` class-1 arm, `patternParamCellHazard`
  re-lane, and the 2b-2 non-CPS cell caveat. Own PR + merge_group A/B (the
  await-using cluster flips lanes).

**3b — class 2 (rep-divergence)**: smaller corpus (the fromAsync
`const expected = [prom]` shape). Candidate: pre-bind the hazardous name to
an EXTERNREF local (uniform boundary rep, field externref) and let the
dynamic-read ladders handle it; the blocker to verify is the mid-body retype
paths (#3037-style slot retyping re-allocs the local, orphaning the prologue
binding). If that verification fails, 3b may fold into #3134 (the Promise<T>
slot-rep fix) which removes the known divergence source.

**2c — delete** `emitAsyncStateMachine`/`splitBodyAtAwait`/`compileNestedAwait`
CPS arm/`asyncCpsActive` plumbing/CPS-only import detection once 3a+3b land
(or 3a lands and 3b's population is measured ≈0 on the corpus).

## Phase 3a — IMPLEMENTED (2026-07-11, this PR)

Exactly per the spec above; notes on what the implementation surfaced:

- `buildAsyncFrameInfo` computes `spillCellInfo` (spill idx → cell type +
  inner valType) with the shared `collectNestedRefsAndAssigns` predicate;
  flagged fields are typed `(ref null $__ref_cell_<T>)`. Body locals require
  `isSpillSafeType(valType)` (the entry cell needs an inert default) — the
  non-defaultable residue is ref-typed and thus already class-2-declined on
  the closure path. Derived params force-box for ANY valType (live init).
  Async-generator frames untouched (`asteriskToken` guard).
- The resume prologue registers flagged names in `resumeFctx.boxedCaptures`
  (CLONING the outer-shared map first — mutating `info.boxedCaptures` in
  place would pollute the activating fctx) and `emitDeliver` writes a
  force-boxed resume binding THROUGH the cell (`struct.set` field 0), since
  its slot now holds the cell ref, not the value.
- The 2b-2 `patternParamCellHazard` decline and the #2873 class-1 arm of
  `asyncClosureCellSpillHazard` are removed. Class 2 (ref-typed spill-guess
  rep divergence) is now the ONLY CPS re-lane (→ 3b / #3134).
- **Latent #2623 consumer bug exposed and fixed** (the one real corpus
  regression pre-fix): `nestedFuncCaptures` registered `valType: c.type` —
  for a mutable capture whose outer slot was ALREADY the canonical cell,
  that is the CELL type, and every call-site consumer derives the capture
  param via `getOrRegisterRefCellType(valType)` → a CELL-OF-CELL, then casts
  the real cell to it — "illegal cast" trap (test262 fromAsync
  sync-iterable-with-rejecting-thenable-closes: a nested GENERATOR with a
  `finally` mutating a captured counter; pre-3a the async body never had a
  pre-boxed slot at nested-decl compile time, so the bug was latent).
  Registration now stores the INNER value type for mutable alreadyBoxed
  captures; the lifted param (`valueCaptureParamTypes` threads the cell
  unchanged) and the call site's derived type then agree, and the
  already-boxed branch passes the existing cell.

Validation: engine-convergence suite (incl. 3 new 3a cases: cell identity
across suspend, boxed resume-binding delivery, post-resume write visible to
the nested closure; the two former routing pins INVERTED to drive+correct —
the derived-param cell shape now returns the value CPS got WRONG); corpus
sweep of await-using + AsyncDisposableStack + fromAsync (134 files): 80
pass, 0 regressions vs the js-host baseline (remaining fails
baseline-identical, incl. an identical illegal-cast failure mode on
mapfn-result-awaited-once-per-iteration); issue-1712's single fail
control-verified identical on pristine main (2ff0db4f0a). merge_group A/B
is the hard gate (the await-using cluster flips CPS→drive).

## Slice 2c (CPS deletion) — DONE (2026-07-11, unblocked by #3134)

The CPS engine is DELETED. #3134 (Promise<T> value-slot rep → externref)
landed first and dissolved the class-2 blocker below: a `Promise<T>[]` vec
element now resolves to `vec<externref>`, matching the stored promise, so the
async-frame spill guess no longer diverges and the class-2 fromAsync closures
DRIVE on the frame engine.

**Measured (this branch, corpus sweep: fromAsync + await-using +
AsyncDisposableStack, 134 files, js-host baseline):**

- baseline (main+#3134, class-2 still declined to CPS): pass **80**;
- CPS deleted + class-2 admitted: pass **81** — **0 regressions, +1
  improvement** (`fromAsync/non-iterable-input-does-not-use-array-prototype`).
  The prediction held: with the rep fixed, the former CPS population drives
  identically-or-better.

**Deleted** (~-582 src LOC across 6 files):

- `emitAsyncStateMachine` + `emitMakeContinuationCallback` (async-cps.ts);
- `compileSyntheticAsyncContinuation` + `AsyncCapture`/`SyntheticContinuation`
  (closures.ts);
- the `cps` lane in `decideAsyncActivation`/`emitAsyncLane` + the `AsyncLane`
  `"cps"` variant + the whole `planAsyncClosureActivation` CPS re-lane
  (discard-tail / value-return-suffix guards + `suffixReturnsValue`)
  (async-activation.ts);
- `asyncClosureCellSpillHazard` (async-frame.ts — class-2 no longer declines);
- `asyncCpsActive` (context/types.ts) + its `AwaitExpression` guard
  (expressions.ts).

**KEPT** (still-live classifier predicates, not the CPS emitter):
`asyncFnNeedsCps` + `splitBodyAtAwait` remain in async-cps.ts — used by
`collectAsyncCpsImports` (declarations.ts, host-import registration) and
`calleeIsDriveLowered` (expressions.ts, wasi drive shape check). They classify;
they no longer drive an emitter.

One suspension engine on the JS-host lane (`async-frame.ts`), acceptance met.
The 2 pre-existing `promise-combinators` failures (Promise.all/race with
resolved values) are engine-independent and out of scope.

---

### (superseded) Slice 2c — BLOCKED on class-2 rep-unification (2026-07-11)

Attempted the CPS-engine deletion (`emitAsyncStateMachine`,
`splitBodyAtAwait`, `compileSyntheticAsyncContinuation`, `asyncCpsActive`).
The deletion mechanics are straightforward (the decl lane never uses CPS
post-slice-1; only the class-2 closure re-lane does). **But it regresses 8
baseline-PASSING test262 files** and cannot ship until class-2 is solved:

**Hard evidence (measured, this session).** With CPS deleted, class-2 closures
(a non-resume-binding body local whose spill GUESS is a typed vec/struct — the
`fromAsync` iterable-input family) fall to the legacy sync-void path and
return NaN. Corpus sweep delta vs phase-3a: **pass 80 → 72**, all 8
regressions are baseline-`pass` files, every one a class-2 closure:
`fromAsync/{async-iterable-input, async-iterable-input-does-not-await-input,
non-iterable-input, non-iterable-input-with-thenable,
non-iterable-with-non-promise-thenable, sync-iterable-input,
sync-iterable-input-with-non-promise-thenable, sync-iterable-input-with-thenable}`.
Only the CPS engine currently lowers these correctly, so CPS is **not
deletable** while they pass.

**Why class-2 can't be fixed at the frame-layout level** (four approaches
tried, all fail):

1. cell of the guess type → `struct.set[0] expected (ref null 18), found (ref
null 4)` — the spill GUESS's vec typeIdx (18) diverges from the body's
   context-specific array-literal vec typeIdx (4). Invalid Wasm.
2. cell of the nullable-widened guess → same typeIdx divergence. Invalid.
3. externref-valued cell → validates, but `arr[0]` derefs the cell to
   externref and the vec loses its indexable rep → NaN.
4. plain externref spill field (no cell) → validates, same NaN.

The root cause is structural: the resume fn allocates the spill LOCAL (and the
frame field) from a type GUESS **before** the body compiles, but the body's
true local rep is only known AFTER it compiles (array literals mint
context-specific vec typeIdxs; `#3134`'s Promise-unwrap re-types elements).
Correct handling needs either **compile-body-then-build-frame** (a two-phase
frame builder — the resume body learns real local types, then the layout is
fixed) or **#3134's rep unification** (a single canonical vec rep so guess ==
actual). Both are their own hard tasks.

**Recommendation:** keep the CPS engine until #3134 (or a two-phase frame
builder) lands; then 2c is a mechanical deletion. The convergence is otherwise
COMPLETE — after slices 1/2a/2b + phase 3a, CPS's ONLY remaining live route is
the class-2 closure re-lane (~8 corpus files). Reframed acceptance: 2c depends
on #3134. (The class-1 force-boxing + #2623 fix from phase 3a are already on
`main`; this class-2 residue is the sole blocker.)
