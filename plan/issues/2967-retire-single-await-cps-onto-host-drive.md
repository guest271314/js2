---
id: 2967
title: "Async engine convergence: retire emitAsyncStateMachine/splitBodyAtAwait onto the #2906 host-drive engine; widen planLinearAwaits gaps once for both lanes"
status: in-progress
assignee: ttraenkler/fable-senior2
created: 2026-07-02
updated: 2026-07-10
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
  engine-invariant, so the lowered *population* is unchanged — only the engine
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
