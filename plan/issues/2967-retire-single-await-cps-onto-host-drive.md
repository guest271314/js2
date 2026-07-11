---
id: 2967
title: "Async engine convergence: retire emitAsyncStateMachine/splitBodyAtAwait onto the #2906 host-drive engine; widen planLinearAwaits gaps once for both lanes"
status: in-progress
assignee: ttraenkler/fable-senior
created: 2026-07-02
updated: 2026-07-11
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
goal: async-model
sprint: current
parent: 1042
depends_on: [1042]
related: [2906, 2957, 1373b]
origin: "#1042 host-drive PR (2026-07-02) — deliberate scope cut: the CPS lane was left byte-stable; convergence is its own measured step"
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/closures.ts
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
